# -*- coding: utf-8 -*-
"""原生录音控制回归；无真实麦克风，禁止导入旧采集模块。"""
from __future__ import annotations
import os
import sys
import tempfile
import threading
import unittest
from unittest import mock
import numpy as np
import soundfile as sf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
import main as backend_main
import mf_capture
import audio_devices

INPUTS = [{"id": "endpoint-1", "name": "Test mic", "default": True},
          {"id": "endpoint-2", "name": "Other mic", "default": False}]


class FakeNativeCapture:
    def __init__(self):
        self.calls = []
        self.fail_start = self.fail_read = self.fail_stop = self.fail_query = False
        self.on_read = None
        self.read_gate = None
        self.read_entered = threading.Event()
        self.discontinuities = 0

    def devices(self):
        if self.fail_query:
            raise mf_capture.CaptureError("injected device query failure")
        return [dict(item) for item in INPUTS]

    def __call__(self, output, seconds, info, stop, on_level, **kwargs):
        call = {"info": info, "closed": False, **kwargs}
        self.calls.append(call)
        try:
            if stop.is_set(): raise mf_capture.CaptureError("cancelled before capture")
            if self.fail_start: raise mf_capture.CaptureError("injected start failure")
            self.read_entered.set()
            if self.read_gate is not None and not self.read_gate.wait(2):
                raise mf_capture.CaptureError("test gate timeout")
            if self.fail_read: raise mf_capture.CaptureError("injected read failure")
            if self.on_read is not None: self.on_read()
            rate = kwargs["sample_rate"]
            frames = int(min(seconds, 0.1) * rate) if stop.is_set() else int(seconds * rate)
            audio = (0.2 * np.sin(np.arange(frames) * 2 * np.pi * 220 / rate)).astype("float32")
            on_level({"type": "record_level", "level": 0.1, "elapsed": frames/rate, "duration": seconds})
            sf.write(output, audio, rate, subtype="PCM_16")
            if self.fail_stop: raise mf_capture.CaptureError("injected finish failure")
            return {"ok": True, "frames": frames, "sampleRate": rate, "channels": 1,
                    "bitsPerSample": 16, "backend": "mediafoundation", "deviceName": info["name"],
                    "duration": frames/rate, "peak": 0.2, "rms": 0.14, "clipped": 0,
                    "discontinuities": self.discontinuities, "streamTicks": 0}
        finally:
            call["closed"] = True


class RecordingRegression(unittest.TestCase):
    def setUp(self):
        os.makedirs(os.path.join(ROOT, "build"), exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="recording-test-", dir=os.path.join(ROOT, "build"))
        self.addCleanup(self.temp.cleanup)
        self.native = FakeNativeCapture()
        self.messages = []
        self.condition = threading.Condition()
        def emit(message):
            with self.condition:
                self.messages.append(message); self.condition.notify_all()
        for patcher in [mock.patch.dict(sys.modules, {"sounddevice": None, "pyaudio": None}),
                        mock.patch.object(backend_main, "_data_dir", return_value=self.temp.name),
                        mock.patch.object(backend_main, "emit", side_effect=emit),
                        mock.patch.object(mf_capture, "list_devices", side_effect=self.native.devices),
                        mock.patch.object(mf_capture, "capture_to_wave", side_effect=self.native)]:
            patcher.start(); self.addCleanup(patcher.stop)
        self.backend = backend_main.Backend(mock=False)
        self.addCleanup(self.backend.stop_record)

    def results(self): return [m for m in self.messages if m.get("type") == "record_result"]

    def record(self, seconds=0.06, config=None):
        expected = len(self.results()) + 1
        self.backend.record_test(seconds, config if config is not None else {"audioDevice": "endpoint-1"})
        with self.condition:
            self.assertTrue(self.condition.wait_for(lambda: len(self.results()) >= expected, timeout=2))
        return self.results()[-1]

    def test_natural_completion_can_record_three_times(self):
        for _ in range(3):
            self.assertTrue(self.record()["ok"])
            self.assertIsNone(self.backend._record_stop)
        self.assertEqual(len(self.native.calls), 3)
        self.assertTrue(all(call["closed"] for call in self.native.calls))

    def test_stop_then_record_again(self):
        self.native.on_read = self.backend.stop_record
        result = self.record(5)
        self.assertTrue(result["ok"]); self.assertLess(result["duration"], 1)
        self.native.on_read = None
        self.assertTrue(self.record()["ok"])

    def test_stop_before_first_frame_cannot_publish_empty_wav(self):
        stop = threading.Event(); stop.set(); self.backend._record_stop = stop
        self.backend._do_record_test(0.06)
        self.assertFalse(self.results()[-1]["ok"])
        self.assertIsNone(self.backend._record_stop)

    def test_failures_close_native_capture_and_allow_retry(self):
        for field in ("fail_start", "fail_read", "fail_stop", "fail_query"):
            setattr(self.native, field, True)
            self.assertFalse(self.record()["ok"], field)
            self.assertIsNone(self.backend._record_stop)
            self.assertTrue(all(call["closed"] for call in self.native.calls))
            setattr(self.native, field, False)
            self.assertTrue(self.record()["ok"])

    def test_failed_save_keeps_previous_wav(self):
        first = self.record(); path = first["path"]
        with open(path, "rb") as handle: previous = handle.read()
        with mock.patch.object(sf, "write", side_effect=OSError("injected disk failure")):
            self.assertFalse(self.record()["ok"])
        with open(path, "rb") as handle: self.assertEqual(handle.read(), previous)
        self.assertTrue(self.record()["ok"])

    def test_default_and_explicit_endpoint_use_only_mf_catalog(self):
        self.assertTrue(self.record(config={"audioDevice": None})["ok"])
        self.assertEqual(self.native.calls[-1]["info"]["id"], "endpoint-1")
        self.assertTrue(self.record(config={"audioDevice": "endpoint-2"})["ok"])
        self.assertEqual(self.native.calls[-1]["info"]["id"], "endpoint-2")

    def test_record_format_is_pcm16_44100_mono(self):
        result = self.record(0.1); info = sf.info(result["path"])
        self.assertEqual((info.samplerate, info.frames, info.channels, info.subtype), (44100, 4410, 1, "PCM_16"))
        self.assertEqual(self.native.calls[-1]["sample_rate"], 44100)

    def test_native_discontinuities_remain_visible(self):
        self.native.discontinuities = 2
        self.assertEqual(self.record()["discontinuities"], 2)

    def test_legacy_backend_setting_cannot_enable_portaudio(self):
        self.assertTrue(self.record(config={"audioDevice": "endpoint-1", "recordBackend": "portaudio"})["ok"])
        self.assertEqual(self.results()[-1]["backend"], "mediafoundation")

    def test_legacy_numeric_device_fails_instead_of_selecting_wrong_microphone(self):
        self.assertFalse(self.record(config={"audioDevice": 23})["ok"])
        self.assertFalse(self.native.calls)
        self.assertIn("旧版麦克风编号", self.results()[-1]["detail"])

    def test_duplicate_start_while_stopping_does_not_open_second_capture(self):
        self.native.read_gate = threading.Event()
        self.backend.record_test(5, {"audioDevice": "endpoint-1"})
        self.assertTrue(self.native.read_entered.wait(1))
        self.backend.stop_record(); self.backend.record_test(5, {"audioDevice": "endpoint-1"})
        self.native.read_gate.set()
        with self.condition: self.assertTrue(self.condition.wait_for(lambda: len(self.results()) == 1, 1))
        self.assertEqual(len(self.native.calls), 1)

    def test_failed_worker_start_allows_retry(self):
        with mock.patch.object(threading.Thread, "start", side_effect=RuntimeError("thread failure")):
            self.assertFalse(self.record()["ok"])
        self.assertTrue(self.record()["ok"])

    def test_recording_excludes_mic_test_and_realtime(self):
        self.native.read_gate = threading.Event()
        self.backend.record_test(5, {"audioDevice": "endpoint-1"})
        try:
            self.assertTrue(self.native.read_entered.wait(1))
            self.backend.mic_test(); self.backend.start()
            self.assertFalse(self.backend.running)
            self.assertFalse(next(m for m in self.messages if m.get("type") == "mic_test")["ok"])
            self.backend.stop_record()
        finally: self.native.read_gate.set()
        with self.condition: self.assertTrue(self.condition.wait_for(lambda: bool(self.results()), 1))

    def test_invalid_duration_never_opens_capture(self):
        for value in (0, -1, 61, float("nan")):
            self.assertFalse(self.record(value)["ok"])
        self.assertFalse(self.native.calls)


class DeviceResolutionRegression(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(mf_capture, "list_devices", return_value=INPUTS)
        patcher.start(); self.addCleanup(patcher.stop)
    def test_id_roundtrip(self): self.assertEqual(audio_devices.resolve_input_device("endpoint-2")["id"], "endpoint-2")
    def test_default_is_catalog_default_not_first_name(self):
        self.assertEqual(audio_devices.resolve_input_device()["id"], "endpoint-1")
        self.assertTrue(all(item["api"] == "Windows Media Foundation" for item in audio_devices.list_input_devices()))
    def test_absent_device_has_no_fallback(self):
        with self.assertRaises(mf_capture.CaptureError): audio_devices.resolve_input_device("removed-endpoint")
    def test_missing_default_has_no_random_fallback(self):
        with self.assertRaises(mf_capture.CaptureError): mf_capture.resolve_device(None, inputs=[{**item, "default": False} for item in INPUTS])


if __name__ == "__main__": unittest.main(verbosity=2)
