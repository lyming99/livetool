# -*- coding: utf-8 -*-
"""Windows Media Foundation microphone adapter.

Uses the same source-reader / PCM16 conversion pipeline as record_windows 1.0.7
(the recorder used by wenzflow), without introducing Flutter or a .NET runtime.
WAV mode uses small JSON messages and a private file; live mode uses binary
PCM on stdout and separate JSON controls on stderr. No capture fallback exists.
"""
from __future__ import annotations

from collections import deque
import json
import math
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import wave


class CaptureError(RuntimeError):
    pass


def helper_path() -> Path:
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
        return base / "livetool-audio-capture.exe"
    return Path(__file__).resolve().parents[1] / "build" / "native-audio" / "livetool-audio-capture.exe"


def _options() -> dict:
    return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0}


def list_devices(executable: Path | None = None) -> list[dict]:
    executable = executable or helper_path()
    if not executable.is_file():
        raise CaptureError("缺少 Windows 原生录音组件，请重新安装新版；源码运行先执行 tools\\build_audio_capture.cmd")
    try:
        completed = subprocess.run(
            [str(executable), "--list"], capture_output=True, stdin=subprocess.DEVNULL,
            text=True, encoding="utf-8", errors="replace", timeout=10, **_options(),
        )
        messages = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        raise CaptureError(f"枚举 Windows 录音设备失败：{exc}") from exc
    result = next((m for m in messages if m.get("type") == "devices"), None)
    if completed.returncode or result is None:
        detail = next((m.get("detail") for m in messages if m.get("type") == "error"), completed.stderr[-1000:])
        raise CaptureError(f"Windows 原生录音组件不可用：{detail or completed.returncode}")
    return result.get("inputs", [])


def select_device(inputs: list[dict], name: str) -> dict:
    """Never silently switch to a different microphone if mapping is ambiguous."""
    normalize = lambda text: " ".join(str(text).split()).casefold()
    matches = [item for item in inputs if normalize(item.get("name", "")) == normalize(name)]
    if len(matches) != 1:
        raise CaptureError(f"无法唯一匹配麦克风“{name}”，请刷新并重新选择设备")
    return matches[0]


def resolve_device(device=None, *, inputs=None) -> dict:
    if isinstance(device, dict):
        if not device.get("id") or not device.get("name"):
            raise CaptureError("无效的 Media Foundation 麦克风端点")
        return dict(device)
    if device is not None and not isinstance(device, str):
        raise CaptureError("旧版麦克风编号已停用，请在设置中刷新并重新选择麦克风")
    catalog = list_devices() if inputs is None else inputs
    if device is None or device == "":
        defaults = [item for item in catalog if item.get("default")]
        if len(defaults) != 1:
            raise CaptureError("Windows 未设置可用的默认麦克风，请明确选择设备")
        return defaults[0]
    found = [item for item in catalog if item.get("id", "").casefold() == device.casefold()]
    if len(found) == 1:
        return found[0]
    # Compatibility for internal diagnostic callers that specify a friendly name:
    # still resolves ONLY against Media Foundation, never a legacy capture API.
    return select_device(catalog, device)


def capture_to_wave(output: str, seconds: float, device_name: str, stop_event,
                    on_level, *, sample_rate: int = 44100, channels: int = 1,
                    executable: Path | None = None, popen_factory=None) -> dict:
    """Capture to a new/empty WAV, verify its contract, and return capture metadata.

    This is NOT a Windows RAW/APO-bypass mode. No application DSP is applied;
    Windows performs the requested PCM16 conversion, as in the reference project.
    """
    if not math.isfinite(seconds) or not 0 < seconds <= 60:
        raise CaptureError("录音时长必须在 0 到 60 秒之间")
    if stop_event.is_set():
        raise CaptureError("录音已取消，尚未采集到音频")
    executable = executable or helper_path()
    selected = resolve_device(device_name, inputs=(None if isinstance(device_name, dict) else list_devices(executable)))
    if stop_event.is_set():
        raise CaptureError("录音已取消，尚未采集到音频")
    spawn = popen_factory or subprocess.Popen
    proc = spawn(
        [str(executable), "--device", selected["id"], "--output", str(output),
         "--seconds", str(seconds), "--rate", str(sample_rate), "--channels", str(channels)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1, **_options(),
    )
    messages: queue.Queue = queue.Queue()
    stderr = deque(maxlen=16)
    reader_done = threading.Event()

    def stdout_reader():
        try:
            for line in proc.stdout:
                if line.strip():
                    try:
                        message = json.loads(line)
                        if not isinstance(message, dict):
                            raise ValueError("message must be an object")
                        messages.put(message)
                    except (ValueError, TypeError):
                        messages.put({"type": "error", "detail": "原生录音组件返回了无效协议"})
        finally:
            reader_done.set()

    def stderr_reader():
        for line in proc.stderr:
            stderr.append(line.rstrip())

    threads = [threading.Thread(target=stdout_reader, daemon=True),
               threading.Thread(target=stderr_reader, daemon=True)]
    deadline = time.monotonic() + max(15, seconds + 10)
    stopped = False
    result = None
    try:
        for thread in threads:
            thread.start()
        while result is None:
            now = time.monotonic()
            if now >= deadline:
                raise CaptureError("Windows 原生录音响应超时，请检查麦克风后重试")
            if stop_event.is_set() and not stopped:
                stopped = True
                deadline = min(deadline, now + 3)
                try:
                    proc.stdin.write("stop\n")
                    proc.stdin.flush()
                except (OSError, ValueError):
                    pass  # the completed message may already be in the reader queue
            try:
                message = messages.get(timeout=0.05)
            except queue.Empty:
                if reader_done.is_set() and proc.poll() is not None:
                    raise CaptureError("Windows 原生录音意外退出：" + ("; ".join(stderr) or str(proc.returncode)))
                continue
            kind = message.get("type")
            if kind == "error":
                raise CaptureError(str(message.get("detail") or "Windows 原生录音失败"))
            if kind == "record_level":
                on_level(message)
            elif kind == "complete":
                result = message
        try:
            code = proc.wait(timeout=5)
        except subprocess.TimeoutExpired as exc:
            raise CaptureError("Windows 原生录音组件未能结束") from exc
        if code or result.get("ok") is not True:
            raise CaptureError("Windows 原生录音失败：" + ("; ".join(stderr) or str(code)))
        with wave.open(str(output), "rb") as wav:
            actual_rate, actual_channels = wav.getframerate(), wav.getnchannels()
            frames, width = wav.getnframes(), wav.getsampwidth()
            pcm = wav.readframes(frames)
            if (actual_rate != sample_rate or actual_channels != channels or width != 2 or
                    frames <= 0 or len(pcm) != frames * actual_channels * width or
                    result.get("sampleRate") != actual_rate or result.get("channels") != actual_channels or
                    result.get("frames") != frames or result.get("bitsPerSample") != 16):
                raise CaptureError("原生录音的 PCM 格式、数据长度与元数据不一致")
        for field in ("peak", "rms", "clipped"):
            value = result.get(field)
            if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise CaptureError("原生录音返回了异常电平数据")
        result.update({"duration": round(frames / actual_rate, 2), "deviceName": selected["name"],
                       "backend": "mediafoundation", "applicationProcessing": False,
                       "windowsRawMode": False})
        return result
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
        for thread in threads:
            if thread.ident is not None:
                thread.join(timeout=2)
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            stream.close()
