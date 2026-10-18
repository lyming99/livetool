# -*- coding: utf-8 -*-
"""云端接口识别引擎（OpenAI 兼容 /audio/transcriptions）。

本地模型之外增加「接口」模式：音频仍在本地采集，按段发给用户配置的 HTTP
接口转写。请求体采用 OpenAI 兼容的 multipart 协议（字段 model / file /
language / response_format），因此 OpenAI、以及多数兼容实现（one-api /
new-api 网关、硅基流动、自建 whisper 服务等）都可以直接使用。

接口模型都不是流式模型，所以策略与本地 Whisper 一致：
  - 说话过程中每 1.2 秒把最近 3 秒音频发一次，结果作为草稿（partial）
  - 检测到静音 0.6 秒，把整句再发一次，作为定稿（final）

网络请求是阻塞的，采集与转写分成两个线程：采集线程只往队列里塞音频，
即使某次请求慢，也不会中断采集（队列满时丢最旧的一块）。
"""

from __future__ import annotations

import io
import json
import queue
import threading
import time
import urllib.error
import urllib.request
import uuid
import wave

SAMPLE_RATE = 16000
BLOCK_SAMPLES = 1600            # 100ms 一块
PARTIAL_INTERVAL = 1.2          # 草稿请求间隔（秒）
PARTIAL_WINDOW = 3.0            # 草稿只看最近 3 秒
SILENCE_RMS = 0.006
SILENCE_SECONDS = 0.6
MAX_UTTERANCE = 12.0            # 单句最长，超过就强制定稿
MIN_UTTERANCE = 0.4             # 短于这个长度的不转写

DEFAULT_MODEL = "whisper-1"
DEFAULT_TIMEOUT = 30
TRANSCRIBE_SUFFIX = "/audio/transcriptions"

# 采集来源对应的运行状态与故障文案（与本地引擎保持一致）
CAPTURE_STATUS = {
    "input": "Media Foundation · 16kHz PCM16 麦克风采集中",
    "output": "WASAPI 环回 · 16kHz PCM16 电脑声音采集中",
}
CAPTURE_INTERRUPTED = {
    "input": "原生麦克风采集中断：",
    "output": "电脑声音采集中断：",
}


def _http_message(status: int, detail: str) -> str:
    """把常见的接口错误翻译成能指导用户处理的提示。"""
    if status in (401, 403):
        head = "接口鉴权失败（密钥无效或没有权限）"
    elif status == 404:
        head = "接口地址不存在，请检查地址是否包含 /v1"
    elif status == 429:
        head = "接口请求过于频繁或额度不足"
    elif status >= 500:
        head = f"接口服务端错误（HTTP {status}）"
    else:
        head = f"接口返回错误（HTTP {status}）"
    detail = " ".join((detail or "").split())
    return f"{head}：{detail[:200]}" if detail else head


def _wav_bytes(audio) -> bytes:
    """把 float32 [-1, 1] 单声道音频编码成 PCM16 WAV。"""
    import numpy as np

    samples = np.asarray(audio, dtype=np.float32)
    if samples.ndim > 1:
        samples = samples.reshape(-1)
    pcm = np.clip(samples, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2").tobytes()
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm)
    return buffer.getvalue()


def _multipart(fields: list[tuple[str, str]], content: bytes, boundary: str) -> bytes:
    chunks = []
    for name, value in fields:
        chunks.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'
            f"{value}\r\n".encode("utf-8")
        )
    chunks.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\n'
        "Content-Type: audio/wav\r\n\r\n".encode("utf-8")
    )
    chunks.append(content)
    chunks.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks)


class ApiEngine:
    def __init__(self, config: dict | None = None, models_dir: str = "") -> None:
        cfg = config or {}
        # 采集来源：input = 麦克风，output = 电脑声音（WASAPI 环回）
        from audio_devices import capture_target

        target = capture_target(cfg)
        self.capture_kind = target["kind"]
        self.audio_device = target["device"]
        self.capture_label = target["label"]

        self.base_url = (cfg.get("apiBaseUrl") or "").strip()
        self.api_key = (cfg.get("apiKey") or "").strip()
        self.model = (cfg.get("apiModel") or "").strip() or DEFAULT_MODEL
        self.language = (cfg.get("apiLanguage") or cfg.get("language") or "zh").strip()
        try:
            timeout = int(float(cfg.get("apiTimeout") or DEFAULT_TIMEOUT))
        except (TypeError, ValueError):
            timeout = DEFAULT_TIMEOUT
        self.timeout = max(5, min(120, timeout))
        self.prompt = (cfg.get("apiPrompt") or "").strip()

        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._reader: threading.Thread | None = None
        self._capture = None
        self._audio_q: queue.Queue = queue.Queue(maxsize=200)
        self.requests = 0

    # ---- 接口信息 ----

    @property
    def endpoint(self) -> str:
        base = self.base_url.rstrip("/")
        if not base:
            return ""
        if base.endswith(TRANSCRIBE_SUFFIX):
            return base
        return base + TRANSCRIBE_SUFFIX

    def describe(self) -> str:
        return f"接口：{self.endpoint or '（未配置）'} · 模型 {self.model}"

    # ---- 生命周期 ----

    def start(self, on_partial, on_final, on_status) -> None:
        if self._stop.is_set():
            return
        if not self.endpoint:
            raise RuntimeError(
                "接口未配置：请在设置的「识别引擎 → 接口」里填写接口地址"
                "（例如 https://api.openai.com/v1）"
            )
        on_status("loading", f"正在准备接口识别（{self.model}）")
        self._thread = threading.Thread(
            target=self._run, args=(on_partial, on_final, on_status),
            daemon=True, name="api-asr",
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        capture = self._capture
        if capture is not None:
            capture.close()
        for thread in (self._reader, self._thread):
            if thread is not None and thread.ident is not None and thread is not threading.current_thread():
                thread.join(timeout=3.0)
        if self._thread is None or not self._thread.is_alive():
            self._thread = None
        if self._reader is None or not self._reader.is_alive():
            self._reader = None

    # ---- 请求 ----

    def _transcribe(self, audio) -> str:
        payload = _wav_bytes(audio)
        fields = [
            ("model", self.model),
            ("response_format", "json"),
            ("temperature", "0"),
        ]
        if self.language and self.language != "auto":
            fields.append(("language", self.language))
        if self.prompt:
            fields.append(("prompt", self.prompt))

        boundary = "----livetool" + uuid.uuid4().hex
        body = _multipart(fields, payload, boundary)
        request = urllib.request.Request(self.endpoint, data=body, method="POST")
        request.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
        request.add_header("Accept", "application/json")
        if self.api_key:
            request.add_header("Authorization", f"Bearer {self.api_key}")

        self.requests += 1
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            try:
                detail = exc.read().decode("utf-8", "replace")
            except Exception:
                detail = ""
            raise RuntimeError(_http_message(exc.code, detail)) from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"无法连接接口：{exc.reason}") from exc
        except TimeoutError as exc:
            raise RuntimeError(f"接口请求超时（{self.timeout} 秒）") from exc

        return self._parse(raw)

    @staticmethod
    def _parse(raw: bytes) -> str:
        text = raw.decode("utf-8", "replace").strip()
        if not text:
            return ""
        try:
            data = json.loads(text)
        except ValueError:
            # 有些兼容实现直接回纯文本
            return text
        if isinstance(data, str):
            return data.strip()
        if isinstance(data, dict):
            for key in ("text", "transcription", "result"):
                value = data.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
            nested = data.get("data")
            if isinstance(nested, dict):
                value = nested.get("text")
                if isinstance(value, str):
                    return value.strip()
        return ""

    # ---- 采集与识别 ----

    def _read_loop(self, on_status) -> None:
        from mf_stream import PcmInputStream

        stream = PcmInputStream(self.audio_device, kind=self.capture_kind,
                                sample_rate=SAMPLE_RATE, stop_event=self._stop)
        self._capture = stream
        try:
            stream.start()
            on_status("running", f"{CAPTURE_STATUS[self.capture_kind]} · 接口转写")
            while not self._stop.is_set():
                audio = stream.read(BLOCK_SAMPLES)
                if not audio.size:
                    break
                try:
                    self._audio_q.put_nowait(audio)
                except queue.Full:
                    # 请求变慢时丢最旧的一块，保证延迟不持续累积
                    try:
                        self._audio_q.get_nowait()
                        self._audio_q.put_nowait(audio)
                    except (queue.Empty, queue.Full):
                        pass
        except Exception as exc:
            if not self._stop.is_set():
                on_status("error", f"{CAPTURE_INTERRUPTED[self.capture_kind]}{exc}")
            self._stop.set()
        finally:
            stream.close()
            self._capture = None

    def _run(self, on_partial, on_final, on_status) -> None:
        import numpy as np

        self._reader = threading.Thread(target=self._read_loop, args=(on_status,),
                                        daemon=True, name="api-audio")
        self._reader.start()

        buffer = np.zeros(0, dtype=np.float32)      # 最近几秒，用于草稿
        pending = np.zeros(0, dtype=np.float32)     # 当前整句，用于定稿
        silence = 0.0
        last_partial = 0.0

        window_samples = int(SAMPLE_RATE * PARTIAL_WINDOW)
        max_samples = int(SAMPLE_RATE * MAX_UTTERANCE)

        while not self._stop.is_set():
            try:
                audio = self._audio_q.get(timeout=0.2)
            except queue.Empty:
                continue

            buffer = np.concatenate([buffer, audio])[-window_samples:]
            pending = np.concatenate([pending, audio])[-max_samples:]

            rms = float(np.sqrt(np.mean(np.square(audio)))) if audio.size else 0.0
            now = time.monotonic()

            if rms >= SILENCE_RMS:
                silence = 0.0
                if now - last_partial >= PARTIAL_INTERVAL and len(buffer) > SAMPLE_RATE * 0.8:
                    last_partial = now
                    try:
                        text = self._transcribe(buffer)
                    except Exception as exc:
                        on_status("running", f"接口转写失败：{exc}")
                        continue
                    if text:
                        on_partial(text)
            else:
                silence += BLOCK_SAMPLES / SAMPLE_RATE
                if silence >= SILENCE_SECONDS and len(pending) >= SAMPLE_RATE * MIN_UTTERANCE:
                    try:
                        text = self._transcribe(pending)
                    except Exception as exc:
                        on_status("running", f"接口转写失败：{exc}")
                        text = ""
                    if text:
                        on_final(text)
                    pending = np.zeros(0, dtype=np.float32)
                    buffer = np.zeros(0, dtype=np.float32)
                    on_partial("")
                    silence = 0.0
