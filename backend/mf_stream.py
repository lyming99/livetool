# -*- coding: utf-8 -*-
"""Continuous 16-bit PCM stream through the same native helper as WAV capture.

Two sources share one protocol: the microphone (Media Foundation capture
endpoint) and the computer's sound output (WASAPI loopback of a speaker).
stdout is binary PCM; stderr is a separate JSON control channel. Nothing is
base64-encoded or written to a growing file for real-time subtitle recognition.
"""
from __future__ import annotations
from collections import deque
import json
import queue
import subprocess
import threading
import time
from mf_capture import CaptureError, helper_path, resolve_device, _options

# Control-channel "backend" value the helper reports for each source kind.
BACKENDS = {"input": "mediafoundation", "output": "wasapi-loopback"}


def drain_queue(target) -> None:
    """Discard audio buffered from the previous capture source."""
    while True:
        try:
            target.get_nowait()
        except queue.Empty:
            return


class PcmInputStream:
    def __init__(self, device=None, *, kind="input", sample_rate=16000, stop_event=None,
                 on_level=None, executable=None, popen_factory=None, queue_limit=512):
        if kind not in BACKENDS:
            raise CaptureError("未知的音频来源类型")
        self.device = device
        self.kind = kind
        self.sample_rate = int(sample_rate)
        self.channels = 1
        self._cancel = stop_event or threading.Event()
        self._on_level = on_level
        self._executable = executable
        self._spawn = popen_factory or subprocess.Popen
        self._queue = queue.Queue(maxsize=queue_limit)
        self._pending = bytearray()
        self._ready = threading.Event()
        self._eof = threading.Event()
        self._controls_done = threading.Event()
        self._error = None
        self._state_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._close_lock = threading.Lock()
        self._closed = False
        self._stop_sent = False
        self._proc = None
        self._threads = []
        self._messages = deque(maxlen=8)
        self.stats = None

    def _request_stop(self):
        with self._write_lock:
            if self._stop_sent or self._proc is None:
                return
            self._stop_sent = True
            try:
                self._proc.stdin.write(b"stop\n")
                self._proc.stdin.flush()
            except (OSError, ValueError):
                pass

    def _label(self) -> str:
        return "麦克风" if self.kind == "input" else "电脑声音"

    def _failure_label(self) -> str:
        return "Windows 原生采集失败" if self.kind == "input" else "Windows 电脑声音采集失败"

    def _fail(self, message):
        with self._state_lock:
            if self._error is None:
                self._error = CaptureError(str(message))
        self._ready.set()
        self._request_stop()

    def _read_pcm(self):
        try:
            while True:
                data = self._proc.stdout.read(4096)
                if not data:
                    break
                if self._closed or self._cancel.is_set() or self._error is not None:
                    continue  # keep draining so the helper cannot block while shutting down
                try:
                    self._queue.put_nowait(data)
                except queue.Full:
                    self._fail("原生音频处理积压，已停止采集；请降低识别模型负载后重试")
        except (OSError, ValueError) as exc:
            if not self._closed and not self._cancel.is_set():
                self._fail(f"读取原生 PCM 失败：{exc}")
        finally:
            self._eof.set()

    def _read_controls(self):
        try:
            for raw in self._proc.stderr:
                try:
                    item = json.loads(raw.decode("utf-8"))
                    if not isinstance(item, dict):
                        raise ValueError("control must be an object")
                except (UnicodeError, ValueError):
                    self._fail("原生 PCM 控制协议无效")
                    continue
                message_type = item.get("type")
                if message_type == "ready":
                    if (item.get("sampleRate") != self.sample_rate or item.get("channels") != 1 or
                            item.get("bitsPerSample") != 16 or
                            item.get("backend") != BACKENDS[self.kind]):
                        self._fail("原生 PCM 流格式不匹配")
                    else:
                        self._ready.set()
                elif message_type == "error":
                    self._fail(item.get("detail") or self._failure_label())
                elif message_type == "record_level" and self._on_level is not None:
                    self._on_level(item)
                elif message_type == "complete":
                    self.stats = item
                else:
                    self._messages.append(str(item))
        except (OSError, ValueError) as exc:
            if not self._closed:
                self._fail(f"原生 PCM 控制通道中断：{exc}")
        finally:
            self._controls_done.set()
            if not self._ready.is_set():
                self._fail(f"原生组件未报告 PCM 流格式；请检查组件版本和{self._label()}权限")

    def start(self):
        if self._closed or self._proc is not None:
            raise CaptureError("原生采集实例不能重复启动")
        if self._cancel.is_set():
            raise CaptureError("原生采集已取消")
        executable = self._executable or helper_path()
        if not executable.is_file():
            raise CaptureError("缺少 Windows 原生采集组件，请重新构建或安装新版")
        self.device = resolve_device(self.device, kind=self.kind)
        if self._cancel.is_set():
            raise CaptureError("原生采集已取消")
        command = [str(executable), "--stream"]
        if self.kind == "output":
            command.append("--loopback")
        command.extend(["--device", self.device["id"],
                        "--rate", str(self.sample_rate), "--channels", "1"])
        try:
            self._proc = self._spawn(
                command,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                bufsize=0, **_options(),
            )
            for target, name in ((self._read_pcm, "mf-pcm"), (self._read_controls, "mf-controls")):
                thread = threading.Thread(target=target, name=name, daemon=True)
                self._threads.append(thread)
                thread.start()
            deadline = time.monotonic() + 10
            while not self._ready.wait(0.05):
                if self._cancel.is_set():
                    raise CaptureError("原生采集已取消")
                if time.monotonic() > deadline:
                    raise CaptureError("等待原生 PCM 采集就绪超时")
            if self._error is not None:
                raise self._error
            if self._cancel.is_set():
                raise CaptureError("原生采集已取消")
            return self
        except BaseException:
            self.close()
            raise

    def read(self, frames):
        import numpy as np
        if not isinstance(frames, int) or frames <= 0:
            raise ValueError("frames must be a positive integer")
        if self._closed or self._cancel.is_set():
            return np.empty(0, dtype=np.float32)
        needed = frames * 2
        deadline = time.monotonic() + 10
        while len(self._pending) < needed:
            if self._closed or self._cancel.is_set():
                return np.empty(0, dtype=np.float32)
            if self._error is not None:
                raise self._error
            try:
                data = self._queue.get(timeout=0.05)
            except queue.Empty:
                if self._eof.is_set():
                    if self._closed or self._cancel.is_set():
                        return np.empty(0, dtype=np.float32)
                    self._controls_done.wait(0.2)
                    if self._error is not None:
                        raise self._error
                    raise CaptureError("原生 PCM 流意外结束")
                if time.monotonic() >= deadline:
                    raise CaptureError(f"{self._label()}长时间未返回 PCM 数据")
                continue
            self._pending.extend(data)
        if self._error is not None:
            raise self._error
        pcm = bytes(self._pending[:needed])
        del self._pending[:needed]
        return np.frombuffer(pcm, dtype="<i2").astype(np.float32) * (1.0 / 32768.0)

    def close(self):
        with self._close_lock:
            if self._closed:
                return
            self._closed = True
            if self._proc is None:
                return
            self._request_stop()
            try:
                self._proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait(timeout=3)
            finally:
                for thread in self._threads:
                    if thread.ident is not None and thread is not threading.current_thread():
                        thread.join(timeout=2)
                for pipe in (self._proc.stdin, self._proc.stdout, self._proc.stderr):
                    pipe.close()

    def __enter__(self):
        return self.start()

    def __exit__(self, *_):
        self.close()


class SwitchablePcmStream:
    """长活的 16k PCM 流，可在不重载模型的前提下换掉底层采集来源。

    识别线程只调用 read()；切换时（麦克风 <-> 电脑声音，或同类换设备）先打开
    新流、再原子换指针并关掉旧流，让正在进行的 read() 自动续到新流上。
    代价只有换源瞬间的一小段静音（通常不到 1 秒）。
    """

    def __init__(self, device=None, *, kind="input", sample_rate=16000, stop_event=None,
                 executable=None, popen_factory=None, queue_limit=512):
        if kind not in BACKENDS:
            raise CaptureError("未知的音频来源类型")
        self.kind = kind
        self.device = device
        self.sample_rate = int(sample_rate)
        self._cancel = stop_event or threading.Event()
        self._executable = executable
        self._spawn = popen_factory
        self._queue_limit = queue_limit
        self._lock = threading.Lock()
        self._stream = None
        self._generation = 0
        self._closed = False
        self.switches = 0

    @property
    def label(self) -> str:
        return "麦克风" if self.kind == "input" else "电脑声音"

    def _make(self, kind, device):
        options = {
            "kind": kind,
            "sample_rate": self.sample_rate,
            "stop_event": self._cancel,
        }
        # 只在非默认队列长度时才传，保持与直接构造 PcmInputStream 相同的调用形态
        if self._queue_limit != 512:
            options["queue_limit"] = self._queue_limit
        if self._executable is not None:
            options["executable"] = self._executable
        if self._spawn is not None:
            options["popen_factory"] = self._spawn
        return PcmInputStream(device, **options)

    def start(self):
        with self._lock:
            if self._closed:
                raise CaptureError("原生采集已关闭")
            if self._stream is not None:
                raise CaptureError("原生采集实例不能重复启动")
            stream = self._make(self.kind, self.device)
        try:
            stream.start()
        except BaseException:
            # 底层流自己启动失败时不会 close，交给这里回收，避免引擎侧留下悬挂句柄
            stream.close()
            raise
        with self._lock:
            if self._closed or self._cancel.is_set():
                stream.close()
                raise CaptureError("原生采集已取消")
            self._stream = stream
            self._generation += 1
        return self

    def read(self, frames):
        import numpy as np

        if not isinstance(frames, int) or frames <= 0:
            raise ValueError("frames must be a positive integer")
        while True:
            with self._lock:
                stream, generation = self._stream, self._generation
                closed = self._closed
            if stream is None or closed or self._cancel.is_set():
                return np.empty(0, dtype=np.float32)
            audio = stream.read(frames)
            with self._lock:
                swapped = self._generation != generation
                alive = not self._closed and self._stream is not None
            if self._cancel.is_set() or not alive:
                return np.empty(0, dtype=np.float32)
            if swapped:
                # 这次读到的是上一个来源的残留数据，丢掉后直接续到新流
                continue
            if not audio.size:
                return audio
            return audio

    def switch(self, kind, device=None):
        """换采集来源；返回 True 表示确实换了（False = 设置没变化）。"""
        if kind not in BACKENDS:
            raise CaptureError("未知的音频来源类型")
        with self._lock:
            if self._closed:
                raise CaptureError("原生采集已关闭")
            if kind == self.kind and device == self.device:
                return False

        # 先开新流：新设备打不开时抛错，旧流继续工作，不会把识别搞停
        new = self._make(kind, device)
        new.start()
        with self._lock:
            if self._closed:
                new.close()
                raise CaptureError("原生采集已关闭")
            old = self._stream
            self._stream = new
            self.kind = kind
            self.device = device
            self._generation += 1
            self.switches += 1
        if old is not None:
            old.close()
        return True

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
            stream, self._stream = self._stream, None
            self._generation += 1
        if stream is not None:
            stream.close()


def switch_engine_capture(engine, kind, device=None) -> dict:
    """三个引擎共用的切换逻辑：换底层采集流，模型与识别线程保持不变。

    切换成功后引擎的 capture_kind / audio_device / capture_label 立即更新，
    并递增 _capture_version；识别线程据此清掉上一来源残留的缓冲，
    避免把麦克风与电脑声音的音频拼成同一句。
    """
    if kind not in BACKENDS:
        raise CaptureError("未知的音频来源类型")
    with engine._switch_lock:
        stream = getattr(engine, "_capture", None)
        if stream is None:
            raise CaptureError("识别尚未开始采集，切换会在下次开始时生效")
        if not isinstance(stream, SwitchablePcmStream):
            raise CaptureError("当前采集流不支持运行中切换，请重新加载模型")
        changed = stream.switch(kind, device)
        if not changed:
            return {"switched": False, "kind": engine.capture_kind,
                    "device": engine.audio_device, "label": engine.capture_label}
        engine.capture_kind = kind
        engine.audio_device = device
        engine.capture_label = "麦克风" if kind == "input" else "电脑声音"
        engine._capture_version += 1
        queue_ref = getattr(engine, "_audio_q", None)
    # 队列在锁外清，避免与采集线程的 put 争锁
    if queue_ref is not None:
        drain_queue(queue_ref)
    return {"switched": True, "kind": kind, "device": device,
            "label": engine.capture_label}
