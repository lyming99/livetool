# -*- coding: utf-8 -*-
"""Media Foundation adapter regression; fake helper protocol, no microphone access."""
from __future__ import annotations
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
import mf_capture
import main as backend_main
import test_recording_regression as legacy


def write_pcm(path, *, rate=44100, frames=4410, channels=1, value=8192):
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(int(value).to_bytes(2, "little", signed=True) * frames * channels)


def metadata(*, frames=4410, rate=44100, channels=1, value=0.25):
    return {"type": "complete", "ok": True, "sampleRate": rate, "channels": channels,
            "bitsPerSample": 16, "frames": frames, "duration": frames / rate,
            "peak": value, "rms": value, "clipped": 0, "streamTicks": 0, "discontinuities": 0}


class Input:
    def __init__(self): self.messages = []; self.closed = False
    def write(self, value): self.messages.append(value)
    def flush(self): pass
    def close(self): self.closed = True


class FakeProcess:
    def __init__(self, lines, code=0):
        self.stdin = Input()
        self.stdout = io.StringIO("\n".join(json.dumps(line) if not isinstance(line, str) else line for line in lines) + "\n")
        self.stderr = io.StringIO("")
        self.returncode = code
        self.killed = False
    def poll(self): return self.returncode
    def wait(self, timeout=None): return self.returncode
    def kill(self): self.killed = True; self.returncode = -1


class AdapterRegression(unittest.TestCase):
    def setUp(self):
        (ROOT / "build").mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="mf-unit-", dir=ROOT / "build")
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / "capture.wav"
        self.stop = threading.Event()
        self.levels = []
        self.process = None
        self.result = metadata()
        self.lines = None
        self.code = 0
        self.wave_rate = 44100
        self.stop_after_spawn = False
        self.patcher = mock.patch.object(mf_capture, "list_devices", return_value=[{"name": "Test mic", "id": "endpoint-1"}])
        self.patcher.start(); self.addCleanup(self.patcher.stop)

    def spawn(self, args, **kwargs):
        self.assertIn("--device", args)
        self.assertEqual(args[args.index("--device") + 1], "endpoint-1")
        write_pcm(self.output, rate=self.wave_rate)
        lines = self.lines if self.lines is not None else [
            {"type": "ready"}, {"type": "record_level", "level": 0.25, "elapsed": 0.1, "duration": 0.1}, self.result]
        self.process = FakeProcess(lines, self.code)
        if self.stop_after_spawn: self.stop.set()
        return self.process

    def capture(self):
        return mf_capture.capture_to_wave(str(self.output), 0.1, "Test mic", self.stop,
                                          self.levels.append, executable=Path("helper.exe"), popen_factory=self.spawn)

    def test_pcm_contract_and_levels_and_all_streams_close(self):
        result = self.capture()
        self.assertEqual(result["backend"], "mediafoundation")
        self.assertEqual(result["sampleRate"], 44100)
        self.assertFalse(result["applicationProcessing"])
        self.assertFalse(result["windowsRawMode"], "do not advertise APO bypass")
        self.assertEqual(len(self.levels), 1)
        self.assertTrue(self.process.stdin.closed and self.process.stdout.closed and self.process.stderr.closed)

    def test_stop_command_is_explicit(self):
        self.stop_after_spawn = True
        self.capture()
        self.assertEqual(self.process.stdin.messages, ["stop\n"])

    def test_cancel_before_launch_does_not_open_microphone(self):
        self.stop.set()
        with self.assertRaises(mf_capture.CaptureError): self.capture()
        self.assertIsNone(self.process)

    def test_error_message_is_failure(self):
        self.lines = [{"type": "error", "detail": "device denied"}]
        with self.assertRaisesRegex(mf_capture.CaptureError, "device denied"): self.capture()
        self.assertTrue(self.process.stdout.closed)

    def test_no_complete_message_is_not_success(self):
        self.lines = [{"type": "ready"}]
        with self.assertRaises(mf_capture.CaptureError): self.capture()

    def test_invalid_protocol_is_not_success(self):
        self.lines = ["not json"]
        with self.assertRaisesRegex(mf_capture.CaptureError, "协议"): self.capture()

    def test_header_sample_rate_mismatch_is_rejected(self):
        self.wave_rate = 48000
        with self.assertRaisesRegex(mf_capture.CaptureError, "不一致"): self.capture()

    def test_reported_frame_count_mismatch_is_rejected(self):
        self.result["frames"] = 123
        with self.assertRaisesRegex(mf_capture.CaptureError, "不一致"): self.capture()

    def test_nonfinite_signal_metadata_is_rejected(self):
        self.result["rms"] = float("nan")
        with self.assertRaisesRegex(mf_capture.CaptureError, "异常电平"): self.capture()

    def test_failed_process_cannot_publish_success(self):
        self.code = 1
        with self.assertRaises(mf_capture.CaptureError): self.capture()

    def test_reader_thread_start_failure_terminates_child(self):
        self.code = None
        with mock.patch.object(threading.Thread, "start", side_effect=RuntimeError("reader thread failure")):
            with self.assertRaisesRegex(RuntimeError, "reader thread failure"):
                self.capture()
        self.assertTrue(self.process.killed)
        self.assertTrue(self.process.stdin.closed)

    def test_device_mapping_must_be_unique(self):
        with self.assertRaises(mf_capture.CaptureError):
            mf_capture.select_device([{"name": "mic"}, {"name": "mic"}], "mic")
        with self.assertRaises(mf_capture.CaptureError): mf_capture.select_device([], "mic")
        self.assertEqual(mf_capture.select_device([{"name": "Test   mic", "id": "x"}], "test mic")["id"], "x")


class BackendMFRegression(unittest.TestCase):
    setUp = legacy.RecordingRegression.setUp
    results = legacy.RecordingRegression.results
    record = legacy.RecordingRegression.record

    def fake_capture(self, output, seconds, name, stop, on_level, **kwargs):
        self.assertEqual(name["id"], "endpoint-1")
        self.assertEqual(kwargs, {"sample_rate": 44100, "channels": 1, "kind": "input"})
        frames = int(seconds * 44100)
        write_pcm(output, frames=frames)
        on_level({"type": "record_level", "level": 0.25, "elapsed": seconds, "duration": seconds})
        return {**metadata(frames=frames), "deviceName": name["name"], "backend": "mediafoundation"}

    def test_native_route_does_not_open_portaudio_and_can_repeat(self):
        with mock.patch.object(mf_capture, "capture_to_wave", side_effect=self.fake_capture):
            for _ in range(3):
                result = self.record(config={"audioDevice": "endpoint-1", "recordBackend": "mediafoundation"})
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["backend"], "mediafoundation")
                self.assertIsNone(self.backend._record_stop)
        self.assertFalse(self.native.calls)

    def test_old_recording_is_preserved_byte_for_byte_and_never_overwritten(self):
        path = Path(self.temp.name) / "test_recording.wav"
        write_pcm(path, frames=100, value=1024)
        original = path.read_bytes()
        with mock.patch.object(mf_capture, "capture_to_wave", side_effect=self.fake_capture):
            result = self.record(config={"audioDevice": "endpoint-1", "recordBackend": "mediafoundation"})
            reference = Path(result["referencePath"])
            self.assertEqual(reference.read_bytes(), original)
            self.assertNotEqual(path.read_bytes(), original)
            self.record(config={"audioDevice": "endpoint-1", "recordBackend": "mediafoundation"})
            self.assertEqual(reference.read_bytes(), original)

    def test_native_failure_keeps_old_wav_and_allows_retry(self):
        path = Path(self.temp.name) / "test_recording.wav"
        write_pcm(path, frames=100)
        original = path.read_bytes()
        with mock.patch.object(mf_capture, "capture_to_wave", side_effect=mf_capture.CaptureError("native failure")):
            self.assertFalse(self.record(config={"audioDevice": "endpoint-1", "recordBackend": "mediafoundation"})["ok"])
        self.assertIsNone(self.backend._record_stop)
        self.assertEqual(path.read_bytes(), original)
        self.assertFalse(list(Path(self.temp.name).glob("recording-mf-*.wav")))
        with mock.patch.object(mf_capture, "capture_to_wave", side_effect=self.fake_capture):
            self.assertTrue(self.record(config={"audioDevice": "endpoint-1", "recordBackend": "mediafoundation"})["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
