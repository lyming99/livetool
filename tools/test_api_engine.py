# -*- coding: utf-8 -*-
"""接口（云端 API）识别引擎回归：不联网、不打开麦克风、不加载模型。

覆盖：地址拼接、请求体契约、错误翻译、分段草稿/定稿、后端创建与环境检查。
"""
from __future__ import annotations

import io
import json
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest import mock

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import api_engine
import installer
from api_engine import ApiEngine


class Response:
    def __init__(self, payload):
        self.payload = payload

    def read(self):
        return self.payload

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def silence(frames=1600):
    return np.zeros(frames, dtype=np.float32)


class EndpointTests(unittest.TestCase):
    def test_suffix_is_appended_to_base_url(self):
        self.assertEqual(ApiEngine({"apiBaseUrl": "https://api.openai.com/v1"}).endpoint,
                         "https://api.openai.com/v1/audio/transcriptions")
        # 末尾斜杠不应产生双斜杠
        self.assertEqual(ApiEngine({"apiBaseUrl": "https://api.openai.com/v1/"}).endpoint,
                         "https://api.openai.com/v1/audio/transcriptions")

    def test_full_endpoint_is_not_duplicated(self):
        url = "https://host/openai/v1/audio/transcriptions"
        self.assertEqual(ApiEngine({"apiBaseUrl": url}).endpoint, url)

    def test_missing_base_url_is_not_startable(self):
        engine = ApiEngine({})
        self.assertEqual(engine.endpoint, "")
        with self.assertRaisesRegex(RuntimeError, "接口未配置"):
            engine.start(lambda text: None, lambda text: None, lambda *args: None)
        self.assertIsNone(engine._thread)

    def test_timeout_and_model_defaults_are_bounded(self):
        self.assertEqual(ApiEngine({}).model, "whisper-1")
        self.assertEqual(ApiEngine({}).timeout, 30)
        self.assertEqual(ApiEngine({"apiTimeout": 999}).timeout, 120)
        self.assertEqual(ApiEngine({"apiTimeout": -3}).timeout, 5)
        self.assertEqual(ApiEngine({"apiTimeout": "abc"}).timeout, 30)


class ParseTests(unittest.TestCase):
    def test_json_text(self):
        self.assertEqual(ApiEngine._parse(json.dumps({"text": "你好"}).encode()), "你好")

    def test_plain_text_fallback(self):
        self.assertEqual(ApiEngine._parse(b"hello"), "hello")

    def test_nested_data_text(self):
        self.assertEqual(ApiEngine._parse(json.dumps({"data": {"text": "x"}}).encode()), "x")

    def test_empty_or_unknown_payload(self):
        self.assertEqual(ApiEngine._parse(b""), "")
        self.assertEqual(ApiEngine._parse(b"{}"), "")
        self.assertEqual(ApiEngine._parse(b'{"other": 1}'), "")


class TranscribeTests(unittest.TestCase):
    def engine(self, **cfg):
        base = {"apiBaseUrl": "https://api.test/v1", "apiKey": "sk-test", "apiModel": "whisper-1"}
        base.update(cfg)
        return ApiEngine(base)

    def test_request_contract(self):
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["request"] = request
            captured["timeout"] = timeout
            return Response(b'{"text": "hello"}')

        with mock.patch.object(api_engine.urllib.request, "urlopen", fake_urlopen):
            text = self.engine()._transcribe(np.full(1600, 0.1, dtype=np.float32))

        self.assertEqual(text, "hello")
        request = captured["request"]
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.full_url, "https://api.test/v1/audio/transcriptions")
        self.assertEqual(captured["timeout"], 30)

        headers = {name.lower(): value for name, value in request.header_items()}
        self.assertEqual(headers["authorization"], "Bearer sk-test")
        self.assertTrue(headers["content-type"].startswith("multipart/form-data; boundary="))

        body = request.data
        self.assertIn(b'name="model"', body)
        self.assertIn(b"whisper-1", body)
        self.assertIn(b'name="language"', body)
        self.assertIn(b'name="file"; filename="audio.wav"', body)
        # 上传的是 PCM16 WAV，不是任意二进制
        self.assertIn(b"RIFF", body)

    def test_missing_key_omits_authorization(self):
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["request"] = request
            return Response(b'{"text": "ok"}')

        with mock.patch.object(api_engine.urllib.request, "urlopen", fake_urlopen):
            self.engine(apiKey="")._transcribe(silence(160))

        headers = {name.lower(): value for name, value in captured["request"].header_items()}
        self.assertNotIn("authorization", headers)

    def test_http_errors_are_translated(self):
        cases = ((401, "鉴权"), (404, "不存在"), (429, "频繁"), (500, "服务端"))
        for code, pattern in cases:
            def raise_error(*args, _code=code, **kwargs):
                raise api_engine.urllib.error.HTTPError(
                    "https://api.test/v1/audio/transcriptions", _code, "boom", {}, io.BytesIO(b'{"error":"x"}'))

            with mock.patch.object(api_engine.urllib.request, "urlopen", raise_error):
                with self.assertRaisesRegex(RuntimeError, pattern):
                    self.engine()._transcribe(silence(160))

    def test_connection_error_mentions_endpoint(self):
        def raise_error(*args, **kwargs):
            raise api_engine.urllib.error.URLError("name resolution failed")

        with mock.patch.object(api_engine.urllib.request, "urlopen", raise_error):
            with self.assertRaisesRegex(RuntimeError, "无法连接接口"):
                self.engine()._transcribe(silence(160))


class ControlledPCM:
    """按块喂音频的假采集流。

    hold=False：块耗尽就把停止标记置上（单线程直接调 _read_loop 时用）。
    hold=True：块耗尽后停在 read 里等 stop，避免采集线程抢先把引擎提前停掉。
    """

    def __init__(self, stop, blocks, hold=False):
        self.stop = stop
        self.blocks = iter(blocks)
        self.hold = hold
        self.closed = False
        self.started = False

    def start(self):
        self.started = True
        return self

    def read(self, frames):
        try:
            return next(self.blocks)
        except StopIteration:
            if self.hold:
                while not self.stop.wait(0.01):
                    pass
            else:
                self.stop.set()
            return np.empty(0, dtype=np.float32)

    def close(self):
        self.closed = True


class LoopTests(unittest.TestCase):
    def config(self, **extra):
        base = {"apiBaseUrl": "https://api.test/v1", "captureSource": "output",
                "audioOutputDevice": "spk-1", "audioDevice": "mic-1"}
        base.update(extra)
        return base

    def wait_closed(self, source, timeout=2.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if source.closed:
                return True
            threading.Event().wait(0.01)
        return source.closed

    def test_run_delivers_partial_then_final_from_output_endpoint(self):
        engine = ApiEngine(self.config())
        self.assertEqual(engine.capture_kind, "output")
        self.assertEqual(engine.audio_device, "spk-1")

        blocks = [np.full(1600, 0.25, dtype=np.float32) for _ in range(9)]
        blocks += [np.zeros(1600, dtype=np.float32) for _ in range(8)]
        source = ControlledPCM(engine._stop, blocks, hold=True)
        lengths = []
        engine._transcribe = lambda audio: (lengths.append(len(audio)), "接口字幕")[1]

        partials, finals, states = [], [], []
        final = threading.Event()

        def on_final(text):
            finals.append(text)
            final.set()

        # 草稿间隔置 0：假采集流几乎瞬时喂完，不需要真实等待 1.2 秒
        with mock.patch.object(api_engine, "PARTIAL_INTERVAL", 0.0), \
                mock.patch("mf_stream.PcmInputStream", return_value=source) as factory:
            thread = threading.Thread(
                target=engine._run,
                args=(partials.append, on_final, lambda *args: states.append(args)),
                daemon=True,
            )
            thread.start()
            try:
                self.assertTrue(final.wait(3), states)
            finally:
                engine.stop()
                thread.join(3)

        factory.assert_called_once_with("spk-1", kind="output", sample_rate=16000,
                                        stop_event=engine._stop)
        self.assertIn("接口字幕", partials)
        self.assertEqual(finals, ["接口字幕"])
        # 草稿用最近 3 秒窗口，定稿用整句，两者长度不同
        self.assertTrue(lengths and lengths[0] <= 16000 * 3)
        self.assertTrue(any("电脑声音" in state[1] for state in states))
        self.assertTrue(self.wait_closed(source))

    def test_microphone_mode_uses_microphone_endpoint(self):
        engine = ApiEngine(self.config(captureSource="input"))
        self.assertEqual(engine.capture_kind, "input")
        self.assertEqual(engine.audio_device, "mic-1")

        source = ControlledPCM(engine._stop, [])
        with mock.patch("mf_stream.PcmInputStream", return_value=source) as factory:
            engine._read_loop(lambda *args: None)
        factory.assert_called_once_with("mic-1", kind="input", sample_rate=16000,
                                        stop_event=engine._stop)
        self.assertTrue(self.wait_closed(source))

    def test_transcribe_failure_reports_status_without_stopping_capture(self):
        engine = ApiEngine(self.config(captureSource="input"))
        blocks = [np.full(1600, 0.25, dtype=np.float32) for _ in range(9)]
        blocks += [np.zeros(1600, dtype=np.float32) for _ in range(8)]
        source = ControlledPCM(engine._stop, blocks, hold=True)
        states = []
        reported = threading.Event()

        def fail(audio):
            raise RuntimeError("接口返回错误（HTTP 500）")

        def status(state, detail=""):
            states.append((state, detail))
            if "接口转写失败" in detail:
                reported.set()

        engine._transcribe = fail
        with mock.patch.object(api_engine, "PARTIAL_INTERVAL", 0.0), \
                mock.patch("mf_stream.PcmInputStream", return_value=source):
            thread = threading.Thread(
                target=engine._run,
                args=(lambda text: None, lambda text: None, status),
                daemon=True,
            )
            thread.start()
            try:
                self.assertTrue(reported.wait(3), states)
            finally:
                engine.stop()
                thread.join(3)

        self.assertTrue(any("接口转写失败" in state[1] for state in states))
        self.assertTrue(self.wait_closed(source))


class BackendWiring(unittest.TestCase):
    def test_backend_creates_api_engine(self):
        import main as backend_main

        backend = backend_main.Backend(mock=False)
        engine = backend._create_engine({"engine": "api", "apiBaseUrl": "https://api.test/v1"})
        self.assertIsInstance(engine, ApiEngine)
        self.assertEqual(engine.endpoint, "https://api.test/v1/audio/transcriptions")

    def test_env_check_validates_endpoint_without_local_deps(self):
        fake_helper = Path(__file__)
        with mock.patch("mf_capture.helper_path", return_value=fake_helper):
            missing = installer.check_env("api", {})
            self.assertEqual(missing["engine"], "api")
            self.assertFalse(missing["ready"])

            bad = installer.check_env("api", {"apiBaseUrl": "api.test/v1"})
            self.assertFalse(bad["ready"])

            ok = installer.check_env("api", {"apiBaseUrl": "https://api.test/v1",
                                             "apiKey": "k", "apiModel": "whisper-1"})
            self.assertTrue(ok["ready"])
            self.assertTrue(any(d["module"] == "mediafoundation" for d in ok["deps"]))

    def test_install_for_api_only_validates_config(self):
        fake_helper = Path(__file__)
        lines = []
        with mock.patch("mf_capture.helper_path", return_value=fake_helper):
            self.assertTrue(installer.run_install(
                "api", {"apiBaseUrl": "https://api.test/v1", "apiKey": "k"}, "", lines.append))
            self.assertFalse(installer.run_install("api", {}, "", lines.append))
        joined = "\n".join(lines)
        self.assertIn("接口模式无需下载模型", joined)
        self.assertIn("填写接口地址", joined)


if __name__ == "__main__":
    unittest.main(verbosity=2)
