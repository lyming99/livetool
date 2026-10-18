# -*- coding: utf-8 -*-
"""系统声音（电脑声音输出 / WASAPI 环回）采集回归。

全部使用假 helper 协议与假设备目录，不打开真实扬声器或麦克风，
不加载任何识别模型。
"""
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

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import audio_devices
import mf_capture
import main as backend_main
from asr_engine import FunAsrEngine
from mf_stream import BACKENDS, PcmInputStream
from whisper_engine import WhisperEngine

INPUTS = [{"id": "mic-1", "name": "Mic", "default": True}]
OUTPUTS = [{"id": "spk-1", "name": "Speaker", "default": True},
           {"id": "spk-2", "name": "Headset", "default": False}]


def write_pcm(path, *, rate=44100, frames=4410, channels=1, value=8192):
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(int(value).to_bytes(2, "little", signed=True) * frames * channels)


def metadata(*, frames=4410, rate=44100, source="output"):
    return {"type": "complete", "ok": True, "sampleRate": rate, "channels": 1,
            "bitsPerSample": 16, "frames": frames, "duration": frames / rate,
            "peak": 0.25, "rms": 0.25, "clipped": 0, "streamTicks": 0,
            "discontinuities": 0, "backend": "wasapi-loopback" if source == "output" else "mediafoundation"}


class TextInput:
    def __init__(self):
        self.messages = []
        self.closed = False

    def write(self, value):
        self.messages.append(value)

    def flush(self):
        pass

    def close(self):
        self.closed = True


class TextProcess:
    """capture_to_wave 走文本行协议。"""

    def __init__(self, lines, code=0):
        self.stdin = TextInput()
        payload = "\n".join(line if isinstance(line, str) else json.dumps(line) for line in lines)
        self.stdout = io.StringIO(payload + "\n")
        self.stderr = io.StringIO("")
        self.returncode = code
        self.killed = False

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -1


def completed(stdout: str, returncode: int = 0, stderr: str = ""):
    return type("Completed", (), {"stdout": stdout, "stderr": stderr,
                                  "returncode": returncode})()


class EndpointEnumeration(unittest.TestCase):
    def setUp(self):
        # 枚举前会校验组件文件存在，这里用临时文件代替真实 helper
        (ROOT / "build").mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="loopback-enum-", dir=ROOT / "build")
        self.addCleanup(self.temp.cleanup)
        self.exe = Path(self.temp.name) / "helper.exe"
        self.exe.touch()

    def test_output_enumeration_uses_list_output_flag(self):
        device_line = json.dumps({"type": "devices", "backend": "mediafoundation",
                                  "kind": "output", "outputs": OUTPUTS})
        with mock.patch.object(mf_capture.subprocess, "run",
                               return_value=completed(device_line + "\n")) as run:
            items = mf_capture.list_output_devices(self.exe)
        self.assertEqual([item["id"] for item in items], ["spk-1", "spk-2"])
        self.assertIn("--list-output", run.call_args[0][0])
        self.assertNotIn("--list", run.call_args[0][0])

    def test_input_enumeration_keeps_original_flag(self):
        device_line = json.dumps({"type": "devices", "backend": "mediafoundation",
                                  "kind": "input", "inputs": INPUTS})
        with mock.patch.object(mf_capture.subprocess, "run",
                               return_value=completed(device_line + "\n")) as run:
            items = mf_capture.list_devices(self.exe)
        self.assertEqual(items[0]["id"], "mic-1")
        self.assertIn("--list", run.call_args[0][0])
        self.assertNotIn("--list-output", run.call_args[0][0])

    def test_resolve_output_device_by_default_and_id(self):
        with mock.patch.object(mf_capture, "list_output_devices", return_value=[dict(d) for d in OUTPUTS]):
            self.assertEqual(mf_capture.resolve_device(None, kind="output")["id"], "spk-1")
            self.assertEqual(mf_capture.resolve_device("spk-2", kind="output")["id"], "spk-2")
            with self.assertRaises(mf_capture.CaptureError):
                mf_capture.resolve_device("missing", kind="output")

    def test_audio_devices_catalog_and_labels(self):
        with mock.patch.object(mf_capture, "list_output_devices", return_value=[dict(d) for d in OUTPUTS]):
            listed = audio_devices.list_output_devices()
            self.assertEqual(len(listed), 2)
            self.assertTrue(all(item["api"] == "Windows WASAPI 环回" for item in listed))


class CaptureTargetSelection(unittest.TestCase):
    def test_default_and_legacy_aliases(self):
        self.assertEqual(audio_devices.capture_target({})["kind"], "input")
        self.assertEqual(audio_devices.capture_target({})["device"], None)
        self.assertEqual(audio_devices.normalize_kind("loopback"), "output")
        self.assertEqual(audio_devices.normalize_kind("system"), "output")
        self.assertEqual(audio_devices.normalize_kind("nonsense"), "input")
        self.assertEqual(audio_devices.normalize_kind(None), "input")

    def test_output_mode_picks_output_device_not_microphone(self):
        target = audio_devices.capture_target({"captureSource": "output",
                                               "audioDevice": "mic-1",
                                               "audioOutputDevice": "spk-2"})
        self.assertEqual(target, {"kind": "output", "device": "spk-2", "label": "电脑声音"})
        target = audio_devices.capture_target({"captureSource": "input",
                                               "audioDevice": "mic-1",
                                               "audioOutputDevice": "spk-2"})
        self.assertEqual(target, {"kind": "input", "device": "mic-1", "label": "麦克风"})


class WaveCapture(unittest.TestCase):
    def setUp(self):
        (ROOT / "build").mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="loopback-unit-", dir=ROOT / "build")
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / "capture.wav"
        self.stop = threading.Event()
        self.levels = []
        self.args = None
        self.lines = None

    def spawn(self, args, **kwargs):
        self.args = args
        write_pcm(self.output)
        lines = self.lines if self.lines is not None else [
            {"type": "ready", "backend": "wasapi-loopback", "sampleRate": 44100,
             "channels": 1, "bitsPerSample": 16},
            {"type": "record_level", "level": 0.2, "elapsed": 0.1, "duration": 0.1},
            metadata(),
        ]
        self.process = TextProcess(lines)
        return self.process

    def capture(self, kind="output"):
        return mf_capture.capture_to_wave(
            str(self.output), 0.1, {"id": "spk-1", "name": "Speaker"}, self.stop,
            self.levels.append, kind=kind, executable=Path("helper.exe"),
            popen_factory=self.spawn)

    def test_loopback_command_and_backend(self):
        result = self.capture("output")
        self.assertIn("--loopback", self.args)
        self.assertEqual(self.args[self.args.index("--device") + 1], "spk-1")
        self.assertEqual(result["backend"], "wasapi-loopback")
        self.assertEqual(result["captureSource"], "output")
        self.assertEqual(result["deviceName"], "Speaker")
        self.assertEqual(len(self.levels), 1)

    def test_microphone_command_has_no_loopback_flag(self):
        result = self.capture("input")
        self.assertNotIn("--loopback", self.args)
        self.assertEqual(result["backend"], "mediafoundation")
        self.assertEqual(result["captureSource"], "input")

    def test_unknown_kind_is_rejected_before_spawning(self):
        with self.assertRaises(mf_capture.CaptureError):
            self.capture("speaker?")

    def test_error_message_from_helper_is_propagated(self):
        self.lines = [{"type": "error", "detail": "speaker disappeared"}]
        with self.assertRaisesRegex(mf_capture.CaptureError, "speaker disappeared"):
            self.capture("output")


class BinaryStreamInput(unittest.TestCase):
    def setUp(self):
        (ROOT / "build").mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="loopback-stream-", dir=ROOT / "build")
        self.addCleanup(self.temp.cleanup)
        self.exe = Path(self.temp.name) / "helper.exe"
        self.exe.touch()
        self.pcm = np.array([-32768, 0, 16384, 32767], dtype="<i2").tobytes()

    def stream(self, controls, kind="output"):
        proc = type("Proc", (), {})()
        proc.stdin = type("In", (), {"sent": [], "write": lambda s, v: s.sent.append(v),
                                     "flush": lambda s: None, "close": lambda s: None})()
        proc.stdout = io.BytesIO(self.pcm)
        proc.stderr = io.BytesIO(b"\n".join(
            item.encode() if isinstance(item, bytes) else json.dumps(item).encode()
            for item in controls) + b"\n")
        proc.returncode = 0
        proc.poll = lambda: proc.returncode
        proc.wait = lambda timeout=None: proc.returncode
        proc.kill = lambda: None
        seen = {}

        def spawn(args, **kwargs):
            seen["args"] = args
            self.assertEqual(kwargs["bufsize"], 0)
            self.assertNotIn("text", kwargs)
            return proc

        self.seen = seen
        return PcmInputStream({"id": "spk-1", "name": "Speaker"}, kind=kind,
                              executable=self.exe, popen_factory=spawn)

    def ready(self, backend):
        return {"type": "ready", "backend": backend, "sampleRate": 16000,
                "channels": 1, "bitsPerSample": 16}

    def test_loopback_ready_and_command(self):
        with self.stream([self.ready("wasapi-loopback")]) as stream:
            audio = stream.read(4)
        self.assertIn("--loopback", self.seen["args"])
        self.assertEqual(self.seen["args"][self.seen["args"].index("--device") + 1], "spk-1")
        np.testing.assert_array_equal(audio, np.array([-1, 0, 0.5, 32767 / 32768], dtype=np.float32))

    def test_backend_mismatch_is_rejected(self):
        stream = self.stream([self.ready("mediafoundation")])
        with self.assertRaisesRegex(mf_capture.CaptureError, "格式不匹配"):
            stream.start()

    def test_unknown_kind_is_rejected(self):
        with self.assertRaises(mf_capture.CaptureError):
            PcmInputStream(None, kind="speaker", executable=self.exe)

    def test_backend_labels_cover_both_sources(self):
        self.assertEqual(set(BACKENDS), {"input", "output"})
        self.assertEqual(BACKENDS["output"], "wasapi-loopback")


class EngineWiring(unittest.TestCase):
    def test_funasr_uses_output_endpoint_and_reports_output_status(self):
        engine = FunAsrEngine({"captureSource": "output", "audioOutputDevice": "spk-2",
                               "audioDevice": "mic-1", "usePunc": False})
        self.assertEqual(engine.capture_kind, "output")
        self.assertEqual(engine.audio_device, "spk-2")
        self.assertEqual(engine.capture_label, "电脑声音")

        class Source:
            def __init__(self, stop):
                self.stop = stop
                self.closed = False
                self.states = []

            def start(self):
                self.stop.set()
                return self

            def read(self, frames):
                return np.empty(0, dtype=np.float32)

            def close(self):
                self.closed = True

        source = Source(engine._stop)
        with mock.patch("mf_stream.PcmInputStream", return_value=source) as factory:
            engine._run(lambda text: None, lambda text: None,
                        lambda *args: source.states.append(args))
        factory.assert_called_once_with("spk-2", kind="output", sample_rate=16000,
                                        stop_event=engine._stop)
        self.assertTrue(any("电脑声音" in state[1] for state in source.states))
        self.assertTrue(source.closed)

    def test_whisper_uses_output_endpoint(self):
        engine = WhisperEngine({"captureSource": "output", "audioOutputDevice": "spk-1"})
        self.assertEqual(engine.capture_kind, "output")
        self.assertEqual(engine.audio_device, "spk-1")

        class Source:
            def __init__(self, stop):
                self.stop = stop
                self.closed = False

            def start(self):
                self.stop.set()
                return self

            def read(self, frames):
                return np.empty(0, dtype=np.float32)

            def close(self):
                self.closed = True

        source = Source(engine._stop)
        with mock.patch("mf_stream.PcmInputStream", return_value=source) as factory:
            engine._read_loop(lambda *args: None)
        factory.assert_called_once_with("spk-1", kind="output", sample_rate=16000,
                                        stop_event=engine._stop)
        self.assertTrue(source.closed)

    def test_microphone_mode_is_unchanged(self):
        engine = FunAsrEngine({"audioDevice": "mic-1"})
        self.assertEqual(engine.capture_kind, "input")
        self.assertEqual(engine.audio_device, "mic-1")


class BackendRecording(unittest.TestCase):
    def setUp(self):
        (ROOT / "build").mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="loopback-backend-", dir=ROOT / "build")
        self.addCleanup(self.temp.cleanup)
        self.messages = []
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(backend_main, "_data_dir", return_value=self.temp.name).start()
        mock.patch.object(backend_main, "emit", side_effect=self.messages.append).start()
        mock.patch.object(mf_capture, "list_output_devices",
                          return_value=[dict(d) for d in OUTPUTS]).start()
        self.calls = []

        def fake_capture(output, seconds, info, stop, on_level, **kwargs):
            self.calls.append({"info": info, **kwargs})
            frames = int(seconds * 44100)
            write_pcm(output, frames=frames)
            on_level({"type": "record_level", "level": 0.2, "elapsed": seconds, "duration": seconds})
            return metadata(frames=frames, source=kwargs.get("kind", "output"))

        mock.patch.object(mf_capture, "capture_to_wave", side_effect=fake_capture).start()
        self.backend = backend_main.Backend(mock=False)
        self.addCleanup(self.backend.stop_record)

    def record(self, config):
        self.backend.record_test(0.06, config)
        for _ in range(100):
            results = [m for m in self.messages if m.get("type") == "record_result"]
            if results:
                return results[-1]
            threading.Event().wait(0.02)
        self.fail("录音没有返回结果")

    def test_output_mode_records_selected_speaker(self):
        result = self.record({"captureSource": "output", "audioOutputDevice": "spk-2"})
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.calls[-1]["info"]["id"], "spk-2")
        self.assertEqual(self.calls[-1]["kind"], "output")
        self.assertEqual(result["captureSource"], "output")
        self.assertEqual(result["backend"], "wasapi-loopback")
        self.assertIn("电脑声音", result["detail"])

    def test_microphone_mode_records_microphone(self):
        with mock.patch.object(mf_capture, "list_devices",
                               return_value=[dict(d) for d in INPUTS]):
            result = self.record({"audioDevice": "mic-1"})
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.calls[-1]["info"]["id"], "mic-1")
        self.assertEqual(self.calls[-1]["kind"], "input")
        self.assertEqual(result["backend"], "mediafoundation")

    def test_device_listing_reports_both_catalogs(self):
        self.backend.list_devices()
        devices = next(m for m in self.messages if m.get("type") == "devices")
        self.assertIn("inputs", devices)
        self.assertIn("outputs", devices)
        self.assertEqual([item["id"] for item in devices["outputs"]], ["spk-1", "spk-2"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
