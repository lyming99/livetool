# -*- coding: utf-8 -*-
"""会话录制回归：WAV 片段、SRT/VTT 字幕、会话清单与日期时间命名。

不需要麦克风，也不加载任何识别模型：直接把构造好的 16k float32 音频
喂给 SessionRecorder，检查落盘结果。
"""
from __future__ import annotations

import json
import os
import struct
import sys
import tempfile
import time
import unittest
import wave
from datetime import datetime

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import session_recorder  # noqa: E402
from session_recorder import SessionRecorder  # noqa: E402

RATE = 16000
FIXED = datetime(2026, 10, 22, 14, 35, 8)


def voiced(seconds: float, amplitude: float = 0.3):
    return np.full(int(RATE * seconds), amplitude, dtype=np.float32)


def silent(seconds: float):
    return np.zeros(int(RATE * seconds), dtype=np.float32)


class RecorderCase(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix="livetool-record-")

    def tearDown(self):
        import shutil

        shutil.rmtree(self.directory, ignore_errors=True)

    def make(self, **kwargs):
        options = {"clock": lambda: FIXED, "sample_rate": RATE}
        options.update(kwargs)
        return SessionRecorder(self.directory, **options)

    def test_session_directory_uses_start_time_and_contains_audio_and_subtitles(self):
        recorder = self.make(segment_seconds=300)
        path = recorder.start()
        self.assertEqual(os.path.basename(path), "20261022-143508")
        self.assertTrue(os.path.isdir(os.path.join(path, "audio")))
        self.assertEqual(recorder.subtitle_path, os.path.join(path, "subtitles.srt"))

        recorder.write_audio(voiced(1.0))
        recorder.write_audio(silent(0.1))
        cue = recorder.add_final("今天我们来聊实时字幕。")
        self.assertIsNotNone(cue)
        manifest = recorder.close("completed")

        self.assertEqual(manifest["status"], "completed")
        self.assertEqual(manifest["startedAt"], FIXED.isoformat(timespec="seconds"))
        self.assertEqual(manifest["audio"]["sampleRate"], RATE)
        self.assertEqual(manifest["audio"]["channels"], 1)
        self.assertEqual(len(manifest["audio"]["segments"]), 1)
        self.assertEqual(manifest["subtitles"]["cues"], 1)
        self.assertEqual(manifest["cues"][0]["text"], "今天我们来聊实时字幕。")

        # 片段是真实可读的 16k 单声道 PCM16 WAV，文件名带开始日期时间
        segment = manifest["audio"]["segments"][0]
        self.assertIn("20261022-143508", segment["file"])
        with wave.open(os.path.join(path, segment["file"]), "rb") as handle:
            self.assertEqual(handle.getframerate(), RATE)
            self.assertEqual(handle.getnchannels(), 1)
            self.assertEqual(handle.getsampwidth(), 2)
            self.assertEqual(handle.getnframes(), int(RATE * 1.1))

        # 字幕用相对会话开始的时间轴（标准字幕格式）
        with open(recorder.subtitle_path, encoding="utf-8") as handle:
            srt = handle.read()
        self.assertIn("00:00:00,000 -->", srt)
        self.assertIn("今天我们来聊实时字幕。", srt)

        with open(os.path.join(path, "session.json"), encoding="utf-8") as handle:
            saved = json.load(handle)
        self.assertEqual(saved["cues"][0]["startedAt"][:19], "2026-10-22T14:35:08")
        self.assertEqual(saved["source"]["kind"], "input")

    def test_cues_use_absolute_and_relative_time_and_stay_ordered(self):
        recorder = self.make()
        recorder.start()
        for _ in range(2):
            recorder.write_audio(voiced(0.8))
            recorder.write_audio(silent(0.7))
            recorder.add_final("第一句")
        manifest = recorder.close()
        cues = manifest["cues"]
        self.assertEqual([cue["index"] for cue in cues], [1, 2])
        self.assertLessEqual(cues[0]["end"], cues[1]["start"])
        self.assertEqual(cues[0]["startedAt"], "2026-10-22T14:35:08.000")
        self.assertTrue(cues[0]["endedAt"].startswith("2026-10-22T14:35:08"))

    def test_audio_is_rotated_into_second_segment_after_limit(self):
        recorder = self.make(segment_seconds=30)
        self.assertEqual(recorder.segment_seconds, 30)
        recorder.start()
        for _ in range(31):
            recorder.write_audio(voiced(1.0, amplitude=0.2))
        manifest = recorder.close()
        segments = manifest["audio"]["segments"]
        self.assertEqual(len(segments), 2)
        self.assertEqual([item["index"] for item in segments], [1, 2])
        self.assertGreaterEqual(segments[1]["startSeconds"], 30.0)
        for item in segments:
            self.assertTrue(os.path.isfile(os.path.join(recorder.directory, item["file"])))

    def test_segment_seconds_and_format_are_clamped(self):
        recorder = self.make(segment_seconds=5, subtitle_format="SRT")
        self.assertEqual(recorder.segment_seconds, 30)
        self.assertEqual(recorder.subtitle_format, "srt")
        # 不落盘也要有安全的 summary，供主进程上报状态
        self.assertEqual(recorder.summary()["segments"], 0)
        self.assertFalse(os.listdir(self.directory))

    def test_vtt_format_writes_webvtt_header(self):
        recorder = self.make(subtitle_format="vtt")
        recorder.start()
        recorder.write_audio(voiced(1.0))
        recorder.write_audio(silent(0.7))
        recorder.add_final("WebVTT 字幕")
        recorder.close()
        self.assertTrue(recorder.subtitle_path.endswith("subtitles.vtt"))
        with open(recorder.subtitle_path, encoding="utf-8") as handle:
            body = handle.read()
        self.assertTrue(body.startswith("WEBVTT"))
        self.assertIn("00:00:00.000 -->", body)

    def test_subtitles_only_skips_audio_directory(self):
        recorder = self.make(include_audio=False)
        path = recorder.start()
        recorder.write_audio(voiced(1.0))
        recorder.add_final("只存字幕")
        manifest = recorder.close()
        self.assertFalse(os.path.isdir(os.path.join(path, "audio")))
        self.assertEqual(manifest["audio"]["enabled"], False)
        self.assertEqual(manifest["audio"]["segments"], [])
        self.assertEqual(manifest["cues"][0]["text"], "只存字幕")

    def test_close_is_idempotent_and_duration_is_tracked(self):
        recorder = self.make()
        recorder.start()
        recorder.write_audio(voiced(2.0))
        first = recorder.close()
        second = recorder.close()
        self.assertEqual(first["durationSeconds"], 2.0)
        self.assertEqual(second["durationSeconds"], 2.0)
        # 关闭后继续喂音频不会写坏文件
        recorder.write_audio(voiced(1.0))
        self.assertEqual(recorder.summary()["durationSeconds"], 2.0)

    def test_wav_header_is_patched_before_close_so_crash_keeps_audio(self):
        # sync_seconds 极小：每次写入后都会把当前长度回填到 WAV 头。
        # 模拟“一直不调用 close() 就断电/被强杀”，文件仍应是可播放的完整片段。
        recorder = self.make(sync_seconds=0.0001, manifest_seconds=0.0001)
        path = recorder.start()
        recorder.write_audio(voiced(1.0, amplitude=0.2))
        segment = recorder.segments[0]["file"]
        with wave.open(os.path.join(path, segment), "rb") as handle:
            self.assertEqual(handle.getnframes(), RATE)
        recorder.write_audio(voiced(0.5, amplitude=0.2))
        with wave.open(os.path.join(path, segment), "rb") as handle:
            self.assertEqual(handle.getnframes(), int(RATE * 1.5))

        # 清单也已按周期刷新，能看到“录制中”的片段与时长（不需要 close）
        with open(os.path.join(path, "session.json"), encoding="utf-8") as handle:
            saved = json.load(handle)
        self.assertEqual(saved["status"], "recording")
        self.assertEqual(saved["durationSeconds"], 1.5)
        self.assertEqual(len(saved["audio"]["segments"]), 1)
        recorder.close()

    def test_header_patch_is_written_as_valid_wav_chunks(self):
        recorder = self.make(sync_seconds=0.0001)
        path = recorder.start()
        recorder.write_audio(voiced(0.4, amplitude=0.2))
        target = os.path.join(path, recorder.segments[0]["file"])
        recorder._sync_headers(force=True)
        with open(target, "rb") as handle:
            header = handle.read(44)
        self.assertEqual(header[:4], b"RIFF")
        self.assertEqual(header[8:12], b"WAVE")
        riff_size = struct.unpack("<I", header[4:8])[0]
        data_size = struct.unpack("<I", header[40:44])[0]
        self.assertEqual(data_size, int(RATE * 0.4) * 2)
        self.assertEqual(riff_size, 36 + data_size)
        recorder.close()

    def test_feed_and_mark_discontinuity_never_raise(self):
        recorder = self.make()
        recorder.start()
        session_recorder.feed(recorder, voiced(0.5))
        session_recorder.mark_discontinuity(recorder)
        session_recorder.feed(None, voiced(0.1))
        session_recorder.mark_discontinuity(None)
        self.assertEqual(recorder.close()["durationSeconds"], 0.5)


if __name__ == "__main__":
    unittest.main()
