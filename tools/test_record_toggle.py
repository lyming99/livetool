# -*- coding: utf-8 -*-
"""运行中启停录制会话的回归。

覆盖用户遇到的现象：识别启动时录制开关是关的，运行中再打开开关。
后端必须立刻补建会话，而不是只等下一次 start()。
不需要麦克风、模型或磁盘：录制器用假对象替代。
"""
from __future__ import annotations

import os
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import main as backend_main  # noqa: E402


class FakeRecorder:
    def __init__(self, directory: str) -> None:
        self.directory = directory
        self.closed: str | None = None
        self.started = False

    def start(self) -> str:
        self.started = True
        return self.directory

    def summary(self) -> dict:
        return {
            "directory": self.directory,
            "subtitlePath": os.path.join(self.directory, "subtitles.srt"),
            "segments": 0,
            "cues": 0,
            "durationSeconds": 0.0,
        }

    def close(self, status: str = "completed") -> dict:
        self.closed = status
        return {"status": status}


class RecordToggleRegression(unittest.TestCase):
    def setUp(self):
        self.messages: list[dict] = []
        patcher = mock.patch.object(backend_main, "emit", side_effect=self.messages.append)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.backend = backend_main.Backend(mock=True)
        self.engine = SimpleNamespace(recorder=None)
        self.created: list[str] = []

    def sessions(self) -> list[dict]:
        return [m for m in self.messages if m.get("type") == "session"]

    def fake_begin(self, cfg: dict) -> None:
        """替身：只建会话、不碰真实设备与磁盘。"""
        if not cfg.get("recordEnabled"):
            self.backend.recorder = None
            self.backend.emit_session("idle", None, "")
            return
        directory = f"/tmp/session-{len(self.created) + 1}"
        self.created.append(directory)
        self.backend.recorder = FakeRecorder(directory)
        self.backend.emit_session("recording", self.backend.recorder, f"正在录制到 {directory}")

    def start_running(self, recorder=None) -> None:
        self.backend.running = True
        self.backend.engine = self.engine
        self.backend.recorder = recorder
        self.engine.recorder = recorder

    def test_switch_is_ignored_while_not_running(self):
        self.backend.set_record(True, {"recordEnabled": True})
        self.assertIsNone(self.backend.recorder)
        self.assertEqual(self.sessions(), [])
        self.assertTrue(self.backend.asr_config["recordEnabled"])

    def test_enabling_while_running_creates_session_and_feeds_engine(self):
        self.start_running()
        with mock.patch.object(self.backend, "_begin_recording", side_effect=self.fake_begin):
            self.backend.set_record(True, {"recordEnabled": True})
        self.assertEqual(len(self.created), 1)
        self.assertIs(self.engine.recorder, self.backend.recorder)
        last = self.sessions()[-1]
        self.assertTrue(last["active"])
        self.assertEqual(last["directory"], self.created[0])

    def test_enabling_twice_does_not_open_second_session(self):
        self.start_running(recorder=FakeRecorder("/tmp/existing"))
        with mock.patch.object(self.backend, "_begin_recording", side_effect=self.fake_begin):
            self.backend.set_record(True, {"recordEnabled": True})
            self.backend.set_record(True, {"recordEnabled": True})
        self.assertEqual(self.created, [])
        self.assertIs(self.engine.recorder, self.backend.recorder)
        self.assertTrue(self.sessions()[-1]["active"])

    def test_disabling_while_running_finalizes_without_touching_recognition(self):
        recorder = FakeRecorder("/tmp/live")
        self.start_running(recorder=recorder)
        self.backend.set_record(False, {"recordEnabled": False})
        self.assertIsNone(self.engine.recorder)
        self.assertIsNone(self.backend.recorder)
        self.assertEqual(recorder.closed, "completed")
        self.assertTrue(self.backend.running)
        last = self.sessions()[-1]
        self.assertFalse(last["active"])
        self.assertIn("录制已保存到 /tmp/live", last["detail"])

    def test_can_reenable_after_disabling(self):
        self.start_running(recorder=FakeRecorder("/tmp/first"))
        self.backend.set_record(False, {"recordEnabled": False})
        with mock.patch.object(self.backend, "_begin_recording", side_effect=self.fake_begin):
            self.backend.set_record(True, {"recordEnabled": True})
        self.assertEqual(self.created, ["/tmp/session-1"])
        self.assertIs(self.engine.recorder, self.backend.recorder)
        self.assertTrue(self.sessions()[-1]["active"])

    def test_start_does_not_use_runtime_switches_to_skip_config(self):
        """set_record 只更新配置，记录开关状态供下次 start() 使用。"""
        self.backend.set_record(False, {"recordEnabled": False, "recordSegmentSeconds": 120})
        self.assertEqual(self.backend.asr_config["recordEnabled"], False)
        self.assertEqual(self.backend.asr_config["recordSegmentSeconds"], 120)


if __name__ == "__main__":
    unittest.main(verbosity=2)
