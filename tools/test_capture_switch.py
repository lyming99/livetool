# -*- coding: utf-8 -*-
"""运行中切换采集来源（麦克风 <-> 电脑声音）的回归。

全部使用假采集流，不打开真实设备、不加载模型。
"""

from __future__ import annotations

import queue
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import mf_stream
import main as backend_main
from mf_stream import CaptureError, SwitchablePcmStream, switch_engine_capture


class FakeInput:
    """替代 PcmInputStream：记录构造参数，按来源返回可区分的音频。"""

    instances: list = []
    fail_next = False

    def __init__(self, device=None, *, kind="input", sample_rate=16000, stop_event=None,
                 executable=None, popen_factory=None, queue_limit=512):
        self.device = device
        self.kind = kind
        self.sample_rate = sample_rate
        self.queue_limit = queue_limit
        self.fail_start = FakeInput.fail_next
        FakeInput.fail_next = False
        self.started = False
        self.closed = False
        FakeInput.instances.append(self)

    def start(self):
        if self.fail_start:
            raise CaptureError("injected stream open failure")
        self.started = True
        return self

    def read(self, frames):
        value = 0.5 if self.kind == "output" else 0.25
        return np.full(frames, value, dtype=np.float32)

    def close(self):
        self.closed = True


class FakeInputPatch(unittest.TestCase):
    def setUp(self):
        FakeInput.instances = []
        FakeInput.fail_next = False
        patcher = mock.patch.object(mf_stream, "PcmInputStream", FakeInput)
        patcher.start()
        self.addCleanup(patcher.stop)


class SwitchableStreamTests(FakeInputPatch):
    def stream(self, kind="input", **kwargs):
        return SwitchablePcmStream("mic-1", kind=kind, stop_event=threading.Event(), **kwargs)

    def test_start_opens_initial_source(self):
        stream = self.stream().start()
        self.assertEqual(len(FakeInput.instances), 1)
        first = FakeInput.instances[0]
        self.assertEqual((first.kind, first.device), ("input", "mic-1"))
        self.assertTrue(first.started)
        self.assertAlmostEqual(float(stream.read(4)[0]), 0.25, places=5)

    def test_switch_opens_new_source_and_closes_old(self):
        stream = self.stream().start()
        old = FakeInput.instances[0]
        self.assertTrue(stream.switch("output", "spk-1"))
        self.assertEqual(stream.kind, "output")
        self.assertEqual(stream.device, "spk-1")
        self.assertEqual(stream.switches, 1)
        new = FakeInput.instances[-1]
        self.assertEqual((new.kind, new.device), ("output", "spk-1"))
        self.assertTrue(old.closed)
        self.assertFalse(new.closed)
        self.assertAlmostEqual(float(stream.read(4)[0]), 0.5, places=5)

    def test_switch_to_same_source_is_noop(self):
        stream = self.stream().start()
        self.assertFalse(stream.switch("input", "mic-1"))
        self.assertEqual(len(FakeInput.instances), 1)
        self.assertEqual(stream.switches, 0)

    def test_failed_switch_keeps_old_source_running(self):
        stream = self.stream().start()
        old = FakeInput.instances[0]
        FakeInput.fail_next = True
        with self.assertRaises(CaptureError):
            stream.switch("output", "spk-1")
        self.assertEqual(stream.kind, "input")
        self.assertFalse(old.closed)
        self.assertAlmostEqual(float(stream.read(4)[0]), 0.25, places=5)

    def test_start_failure_closes_partial_stream(self):
        FakeInput.fail_next = True
        with self.assertRaises(CaptureError):
            self.stream().start()
        self.assertTrue(FakeInput.instances[0].closed)

    def test_close_closes_current_source_and_read_stops(self):
        stream = self.stream().start()
        stream.switch("output", "spk-1")
        current = FakeInput.instances[-1]
        stream.close()
        self.assertTrue(current.closed)
        self.assertEqual(stream.read(4).size, 0)

    def test_unknown_kind_is_rejected(self):
        with self.assertRaises(CaptureError):
            self.stream(kind="speaker")


class EngineStub:
    def __init__(self, capture=None):
        self.capture_kind = "input"
        self.audio_device = "mic-1"
        self.capture_label = "麦克风"
        self._capture_version = 0
        self._switch_lock = threading.Lock()
        self._capture = capture
        self._audio_q = None


class EngineSwitchTests(FakeInputPatch):
    def running_engine(self):
        stream = SwitchablePcmStream("mic-1", kind="input", stop_event=threading.Event())
        stream.start()
        return EngineStub(stream)

    def test_switch_updates_engine_state_and_version(self):
        engine = self.running_engine()
        info = switch_engine_capture(engine, "output", "spk-1")
        self.assertTrue(info["switched"])
        self.assertEqual(engine.capture_kind, "output")
        self.assertEqual(engine.audio_device, "spk-1")
        self.assertEqual(engine.capture_label, "电脑声音")
        self.assertEqual(engine._capture_version, 1)
        self.assertEqual(info["label"], "电脑声音")

    def test_switch_drains_pending_audio_queue(self):
        engine = self.running_engine()
        engine._audio_q = queue.Queue()
        engine._audio_q.put(np.zeros(4, dtype=np.float32))
        switch_engine_capture(engine, "output", "spk-1")
        self.assertTrue(engine._audio_q.empty())

    def test_unknown_kind_is_rejected(self):
        engine = self.running_engine()
        with self.assertRaises(CaptureError):
            switch_engine_capture(engine, "speaker")

    def test_switch_before_capture_starts_is_rejected(self):
        engine = EngineStub(None)
        with self.assertRaisesRegex(CaptureError, "尚未开始采集"):
            switch_engine_capture(engine, "output", "spk-1")

    def test_plain_stream_is_rejected(self):
        engine = EngineStub(FakeInput("mic-1"))
        with self.assertRaisesRegex(CaptureError, "不支持运行中切换"):
            switch_engine_capture(engine, "output", "spk-1")


class BackendSwitchTests(unittest.TestCase):
    def setUp(self):
        self.messages = []
        patcher = mock.patch.object(backend_main, "emit", side_effect=self.messages.append)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.backend = backend_main.Backend(mock=False)
        self.addCleanup(self.backend.stop)

    def last(self):
        return next(m for m in reversed(self.messages) if m.get("type") == "capture_switch")

    def test_not_running_only_saves_config(self):
        self.backend.switch_capture({"captureSource": "output", "audioOutputDevice": "spk-1"})
        result = self.last()
        self.assertTrue(result["ok"])
        self.assertFalse(result["applied"])
        self.assertEqual(result["kind"], "output")
        self.assertEqual(self.backend.asr_config["captureSource"], "output")

    def test_running_engine_is_switched_in_place(self):
        class Engine:
            def __init__(self):
                self.calls = []

            def switch_capture(self, kind, device):
                self.calls.append((kind, device))
                return {"switched": True, "kind": kind, "device": device, "label": "电脑声音"}

        engine = Engine()
        self.backend.running = True
        self.backend.engine = engine
        self.backend.switch_capture({"captureSource": "output", "audioOutputDevice": "spk-2"})
        result = self.last()
        self.assertTrue(result["applied"])
        self.assertEqual(engine.calls, [("output", "spk-2")])

    def test_engine_error_is_reported(self):
        class Engine:
            def switch_capture(self, kind, device):
                raise RuntimeError("device busy")

        self.backend.running = True
        self.backend.engine = Engine()
        self.backend.switch_capture({"captureSource": "output"})
        result = self.last()
        self.assertFalse(result["ok"])
        self.assertIn("device busy", result["detail"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
