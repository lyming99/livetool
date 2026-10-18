# -*- coding: utf-8 -*-
"""原生 PCM 及两个字幕引擎回归：不使用麦克风、不加载/下载模型。"""
from __future__ import annotations
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from mf_capture import CaptureError
from mf_stream import PcmInputStream
from asr_engine import FunAsrEngine
from whisper_engine import WhisperEngine
import main as backend_main

READY = {"type": "ready", "backend": "mediafoundation", "sampleRate": 16000, "channels": 1, "bitsPerSample": 16}
DEVICE = {"id": "endpoint-native", "name": "Native mic", "default": True}


class Input(io.BytesIO):
    def __init__(self): super().__init__(); self.sent = []
    def write(self, value): self.sent.append(value); return super().write(value)


class Chunks(io.BytesIO):
    def __init__(self, chunks): super().__init__(); self.chunks = iter(chunks)
    def read(self, size=-1): return next(self.chunks, b"")


class Process:
    def __init__(self, data, controls, *, chunks=None, live=False):
        self.stdin = Input()
        self.stdout = io.BytesIO(data) if chunks is None else Chunks(chunks)
        self.stderr = io.BytesIO(b"\n".join(json.dumps(item).encode() if isinstance(item, dict) else item for item in controls) + b"\n")
        self.returncode = None if live else 0
        self.killed = False
    def poll(self): return self.returncode
    def wait(self, timeout=None):
        if self.returncode is None: raise subprocess.TimeoutExpired("helper", timeout)
        return self.returncode
    def kill(self): self.killed = True; self.returncode = -1


class StreamRegression(unittest.TestCase):
    def setUp(self):
        (ROOT / "build").mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / "build", prefix="pcm-unit-")
        self.addCleanup(self.temp.cleanup)
        self.exe = Path(self.temp.name) / "helper.exe"; self.exe.touch()
        self.pcm = np.array([-32768, -16384, 0, 16384, 32767], dtype="<i2").tobytes()
        self.proc = None
    def stream(self, controls=None, *, chunks=None, cancel=None, limit=512, live=False):
        self.proc = Process(self.pcm, [READY] if controls is None else controls, chunks=chunks, live=live)
        def spawn(args, **kwargs):
            self.assertIn("--stream", args)
            self.assertEqual(kwargs["bufsize"], 0)
            self.assertNotIn("text", kwargs, "binary PCM must never pass through text decoding")
            return self.proc
        return PcmInputStream(DEVICE, executable=self.exe, popen_factory=spawn,
                              stop_event=cancel, queue_limit=limit)
    def test_signed_pcm16_to_float32_is_lossless_scaling(self):
        with self.stream() as stream:
            audio = stream.read(5)
            np.testing.assert_array_equal(audio, np.array([-1, -0.5, 0, 0.5, 32767/32768], dtype=np.float32))
        self.assertEqual(self.proc.stdin.sent, [b"stop\n"])
        self.assertTrue(self.proc.stdout.closed and self.proc.stderr.closed)
    def test_odd_pipe_boundaries_are_reassembled(self):
        with self.stream(chunks=[self.pcm[:1], self.pcm[1:4], self.pcm[4:7], self.pcm[7:]]) as stream:
            np.testing.assert_array_equal(stream.read(5), np.frombuffer(self.pcm, dtype="<i2") / np.float32(32768))
    def test_pcm_format_mismatch_is_rejected(self):
        stream = self.stream([{**READY, "sampleRate": 44100}])
        with self.assertRaisesRegex(CaptureError, "格式不匹配"): stream.start()
        self.assertTrue(self.proc.stdout.closed)
    def test_missing_control_metadata_never_exposes_random_bytes(self):
        with self.assertRaises(CaptureError): self.stream([]).start()
    def test_control_error_is_propagated(self):
        with self.assertRaisesRegex(CaptureError, "device unplugged"):
            self.stream([{"type": "error", "detail": "device unplugged"}]).start()
    def test_invalid_control_json_is_rejected(self):
        with self.assertRaises(CaptureError): self.stream([b"not json"]).start()
    def test_unexpected_eof_is_error_not_silence(self):
        with self.stream() as stream:
            stream.read(5)
            with self.assertRaises(CaptureError): stream.read(1)
    def test_stop_returns_empty_even_if_pcm_is_buffered(self):
        stop = threading.Event()
        with self.stream(cancel=stop) as stream:
            stream.read(1); stop.set()
            self.assertEqual(stream.read(1).size, 0)
    def test_cancel_racing_with_eof_is_not_a_capture_error(self):
        import queue
        stop = threading.Event()
        with self.stream(cancel=stop) as stream:
            def cancelled(*args, **kwargs):
                stop.set()
                raise queue.Empty
            with mock.patch.object(stream._queue, "get", side_effect=cancelled):
                self.assertEqual(stream.read(1).size, 0)

    def test_close_is_idempotent(self):
        stream = self.stream().start(); stream.close(); stream.close()
        self.assertEqual(self.proc.stdin.sent, [b"stop\n"])
        self.assertTrue(all(not thread.is_alive() for thread in stream._threads))
    def test_hung_helper_is_killed_on_close(self):
        stream = self.stream(live=True).start(); stream.close()
        self.assertTrue(self.proc.killed)
    def test_thread_start_failure_closes_child(self):
        stream = self.stream(live=True)
        with mock.patch.object(threading.Thread, "start", side_effect=RuntimeError("thread fail")):
            with self.assertRaisesRegex(RuntimeError, "thread fail"): stream.start()
        self.assertTrue(self.proc.killed and self.proc.stdout.closed)
    def test_queue_overflow_is_visible_failure_not_silent_drop(self):
        stream = self.stream(chunks=[b"\0\0"]*20, limit=1)
        with self.assertRaisesRegex(CaptureError, "积压"): stream.start()
    def test_cancel_before_start_does_not_spawn(self):
        stop = threading.Event(); stop.set(); stream = self.stream(cancel=stop)
        with self.assertRaises(CaptureError): stream.start()
        self.assertIsNone(stream._proc)


class ControlledPCM:
    def __init__(self, stop, blocks, *, hold=False, fail=False):
        self.stop = stop; self.blocks = iter(blocks); self.hold = hold; self.fail = fail
        self.closed = False; self.started = False
    def start(self):
        self.started = True
        if self.fail: raise CaptureError("injected native open error")
        return self
    def read(self, frames):
        try:
            value = next(self.blocks)
            assert value.shape == (frames,)
            if self.hold: time.sleep(0.005)
            return value
        except StopIteration:
            if self.hold:
                while not self.stop.wait(0.01): pass
            else: self.stop.set()
            return np.empty(0, dtype=np.float32)
    def close(self): self.closed = True


class SubtitleRegression(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(sys.modules, {"sounddevice": None, "pyaudio": None})
        patcher.start(); self.addCleanup(patcher.stop)
    def test_funasr_native_pcm_keeps_600ms_model_chunks_and_final(self):
        engine = FunAsrEngine({"audioDevice": "endpoint-native", "usePunc": False})
        blocks = [np.full(1600, 0.25, dtype=np.float32) for _ in range(6)] + [np.zeros(1600, dtype=np.float32) for _ in range(12)]
        source = ControlledPCM(engine._stop, blocks)
        calls = []; partials = []; finals = []; states = []
        class Model:
            def generate(self, **kwargs):
                calls.append(kwargs)
                if kwargs["is_final"] or not np.any(kwargs["input"]): return []
                return [{"text": "原生字幕"}]
        engine._asr = Model()
        with mock.patch("mf_stream.PcmInputStream", return_value=source) as factory:
            engine._run(partials.append, finals.append, lambda *args: states.append(args))
        factory.assert_called_once_with("endpoint-native", kind="input", sample_rate=16000,
                                        stop_event=engine._stop)
        self.assertEqual(finals, ["原生字幕"])
        self.assertTrue(all(call["input"].shape == (9600,) and call["input"].dtype == np.float32 for call in calls))
        self.assertTrue(any(call["is_final"] for call in calls))
        self.assertEqual(states[0][0], "running")
        self.assertTrue(source.closed)
    def test_whisper_native_pcm_delivers_partial_and_final(self):
        engine = WhisperEngine({"audioDevice": "endpoint-native"})
        blocks = [np.full(1600, 0.25, dtype=np.float32) for _ in range(12)] + [np.zeros(1600, dtype=np.float32) for _ in range(8)]
        source = ControlledPCM(engine._stop, blocks, hold=True)
        final = threading.Event(); partials = []; finals = []; states = []
        engine._load = lambda: None
        engine._transcribe = lambda audio: "原生字幕"
        with mock.patch("mf_stream.PcmInputStream", return_value=source):
            engine.start(partials.append, lambda text: (finals.append(text), final.set()), lambda *args: states.append(args))
            try: self.assertTrue(final.wait(3), states)
            finally: engine.stop()
        self.assertIn("原生字幕", partials)
        self.assertIn("原生字幕", finals)
        self.assertTrue(source.closed)
        self.assertFalse(any(state[0] == "error" for state in states))
    def test_whisper_capture_failure_is_reported_and_stops_waiting(self):
        engine = WhisperEngine(); engine._load = lambda: None
        states = []; failed = threading.Event()
        source = ControlledPCM(engine._stop, [], fail=True)
        with mock.patch("mf_stream.PcmInputStream", return_value=source):
            engine.start(lambda text: None, lambda text: None,
                         lambda state, detail="": (states.append((state, detail)), failed.set() if state == "error" else None))
            self.assertTrue(failed.wait(2)); engine.stop()
        self.assertFalse(any(state[0] == "running" for state in states))
        self.assertTrue(source.closed)
    def test_whisper_inference_error_reports_status_without_name_error(self):
        engine = WhisperEngine(); engine._load = lambda: None
        source = ControlledPCM(engine._stop, [np.full(1600, 0.25, dtype=np.float32) for _ in range(12)], hold=True)
        reported = threading.Event(); states = []
        def fail(audio): raise RuntimeError("injected inference failure")
        engine._transcribe = fail
        def status(state, detail=""):
            states.append((state, detail))
            if "转写失败" in detail: reported.set()
        with mock.patch("mf_stream.PcmInputStream", return_value=source):
            engine.start(lambda text:None, lambda text:None, status)
            try: self.assertTrue(reported.wait(2), states)
            finally: engine.stop()
        self.assertTrue(source.closed)

    def test_protocol_stdout_survives_model_stdout_redirection(self):
        import contextlib
        output = io.StringIO(); redirected = io.StringIO()
        with mock.patch.object(backend_main, "_protocol_stdout", output), contextlib.redirect_stdout(redirected):
            backend_main.emit({"type": "status", "state": "stopped"})
        self.assertEqual(json.loads(output.getvalue())["state"], "stopped")
        self.assertEqual(redirected.getvalue(), "")

    def test_stop_during_model_load_never_opens_capture(self):
        for cls, method in ((FunAsrEngine, "_load_models"), (WhisperEngine, "_load")):
            engine = cls(); entered = threading.Event(); gate = threading.Event()
            setattr(engine, method, lambda: (entered.set(), gate.wait(2)))
            states = []
            with mock.patch("mf_stream.PcmInputStream") as factory:
                thread = threading.Thread(target=engine.start, args=(lambda text:None, lambda text:None, lambda *args:states.append(args)))
                thread.start(); self.assertTrue(entered.wait(1)); engine.stop(); gate.set(); thread.join(2)
                factory.assert_not_called()
                self.assertFalse(any(state[0] == "running" for state in states))
    def test_backend_cancels_boot_and_ignores_old_session_callbacks(self):
        backend = backend_main.Backend(mock=False)
        entered = threading.Event(); gate = threading.Event(); ready = threading.Event(); states = []
        class Engine:
            def __init__(self, slow): self.slow = slow; self.stopped = False
            def start(self, **callbacks):
                if self.slow: entered.set(); gate.wait(2)
                callbacks["on_status"]("running", "old" if self.slow else "new")
                if not self.slow: ready.set()
            def stop(self): self.stopped = True
        first, second = Engine(True), Engine(False)
        with mock.patch.object(backend, "_create_engine", side_effect=[first, second]), mock.patch.object(backend, "on_status", side_effect=lambda *args:states.append(args)):
            backend.start(); self.assertTrue(entered.wait(1))
            self.assertIs(backend.engine, first)
            backend.stop(); backend.start(); self.assertTrue(ready.wait(1))
            gate.set(); time.sleep(0.05); backend.stop()
        self.assertNotIn(("running", "old"), states)
        self.assertIn(("running", "new"), states)
        self.assertTrue(first.stopped and second.stopped)


if __name__ == "__main__": unittest.main(verbosity=2)
