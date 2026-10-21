# -*- coding: utf-8 -*-
"""识别会话录制：把真实音频按片段写成 WAV，把定稿字幕写成标准字幕文件。

每次开始实时识别都会在录制根目录下新建一个以开始时间命名的会话目录：

    recordings/
      20261022-143508/
        session.json                        会话清单（开始/结束时间、来源、片段、字幕索引）
        audio/
          seg-0001-20261022-143508.wav      真实语音片段（PCM16 / 16kHz / 单声道）
          seg-0002-20261022-143518.wav
        subtitles.srt                       标准字幕（相对会话开始的时间轴，毫秒精度）

时间约定：
  - 字幕用相对会话开始的时间轴，这是标准字幕格式的要求；
  - session.json 与片段文件名同时记录绝对日期时间（本地时区），
    方便按时间回查某一段录音；
  - 每条字幕在 session.json 里另带 startedAt / endedAt 绝对时间。

实现要点：
  - 只在音频真正读出来时写盘（识别线程把每块 16k 单声道 float32 交进来），
    不改动任何识别引擎的推理逻辑；
  - 片段按 segment_seconds 切分，切换时会立刻刷新 session.json，
    这样即使进程被强杀，已经录下的片段和字幕也能对上；
  - 字幕用整体重写 + 原子替换，避免追加写到一半时文件损坏。
"""

from __future__ import annotations

import json
import os
import struct
import threading
import time
import wave
from datetime import datetime, timedelta

SAMPLE_RATE = 16000
# 判定「这一块有人在说话」的 RMS 阈值，与识别引擎保持一致
SILENCE_RMS = 0.006
SILENCE_SECONDS = 0.6
# 一条字幕至少这么长，避免出现 0 秒的 cue
MIN_CUE_SECONDS = 0.3
# 拿不到语音边界时，按「最近 N 秒」兜底
FALLBACK_SECONDS = 2.0
SUBTITLE_FORMATS = ("srt", "vtt")
# 崩溃安全：WAV 头最多落后约 1 秒，会话清单最多落后约 5 秒
SYNC_SECONDS = 1.0
MANIFEST_SECONDS = 5.0


def feed(recorder, audio) -> None:
    """把识别线程刚读到的 PCM 交给录制器；录制器缺失或出错都不能影响识别。"""
    if recorder is None:
        return
    try:
        recorder.write_audio(audio)
    except Exception:  # pragma: no cover - 录制失败必须降级为「只识别」
        pass


def mark_discontinuity(recorder) -> None:
    """采集来源切换时调用：丢掉上一路残留的语音边界。"""
    if recorder is None:
        return
    try:
        recorder.mark_discontinuity()
    except Exception:  # pragma: no cover
        pass


def _timestamp(seconds: float, separator: str = ",") -> str:
    total_ms = max(0, int(round(float(seconds) * 1000)))
    hours, rest = divmod(total_ms, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    secs, millis = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{separator}{millis:03d}"


class SessionRecorder:
    """一次实时识别会话的录音 + 字幕落盘器（线程安全）。"""

    def __init__(self, base_dir: str, *, segment_seconds: float = 300,
                 subtitle_format: str = "srt", sample_rate: int = SAMPLE_RATE,
                 engine: str = "", source_kind: str = "input",
                 source_label: str = "麦克风", include_audio: bool = True,
                 clock=None, log=None, sync_seconds: float = SYNC_SECONDS,
                 manifest_seconds: float = MANIFEST_SECONDS) -> None:
        self.base_dir = os.path.abspath(base_dir)
        try:
            seconds = int(segment_seconds or 300)
        except (TypeError, ValueError):
            seconds = 300
        self.segment_seconds = max(30, min(3600, seconds))
        fmt = str(subtitle_format or "srt").strip().lower()
        self.subtitle_format = fmt if fmt in SUBTITLE_FORMATS else "srt"
        self.sample_rate = int(sample_rate) or SAMPLE_RATE
        self.engine = str(engine or "")
        self.source_kind = str(source_kind or "input")
        self.source_label = str(source_label or ("麦克风" if self.source_kind == "input" else "电脑声音"))
        self.include_audio = include_audio is not False
        self._clock = clock or datetime.now
        self._log = log or (lambda *_args, **_kwargs: None)
        # 写盘节奏：WAV 头与清单按这个间隔刷新，进程被强杀时也能保住绝大部分内容
        self._sync_seconds = max(0.0, float(sync_seconds))
        self._manifest_seconds = max(0.0, float(manifest_seconds))
        self._last_sync_at = 0.0
        self._last_manifest_at = 0.0
        self._segment_path = ""
        self._patched_bytes = -1

        self._lock = threading.Lock()
        self._closed = False
        self.directory = ""
        self._started: datetime | None = None
        self._manifest: dict | None = None

        # 音频写入状态
        self._wave = None
        self._segment_bytes = 0
        self._segment_index = 0
        self._segment_started: datetime | None = None
        self.segments: list[dict] = []

        # 时间轴（样本数 -> 秒）
        self._samples = 0

        # 语音边界检测
        self._voiced = False
        self._silence = 0.0
        self._utterance_start = 0.0
        self._pending: tuple[float, float] | None = None

        self._cues: list[dict] = []

    # ---- 生命周期 ----

    @property
    def subtitle_path(self) -> str:
        return os.path.join(self.directory, "subtitles." + self.subtitle_format) if self.directory else ""

    def start(self) -> str:
        stamp = self._clock()
        os.makedirs(self.base_dir, exist_ok=True)
        base = os.path.join(self.base_dir, stamp.strftime("%Y%m%d-%H%M%S"))
        directory, index = base, 1
        while os.path.exists(directory):
            index += 1
            directory = f"{base}-{index}"
        os.makedirs(directory)
        if self.include_audio:
            os.makedirs(os.path.join(directory, "audio"), exist_ok=True)
        with self._lock:
            self.directory = directory
            self._started = stamp
            self._write_subtitles()
            self._write_manifest("recording")
        return directory

    def close(self, status: str = "completed") -> dict | None:
        with self._lock:
            if not self.directory:
                return None
            if self._closed:
                return self._manifest
            self._closed = True
            self._close_segment()
            self._write_subtitles()
            self._manifest = self._write_manifest(status)
            return self._manifest

    # ---- 音频 ----

    def write_audio(self, audio) -> None:
        """接收识别线程读到的 float32 [-1, 1] 单声道音频（16k）。"""
        if self._closed or not self.directory:
            return
        try:
            import numpy as np
        except Exception:  # pragma: no cover - numpy 缺失时只录字幕
            return
        samples = np.asarray(audio, dtype=np.float32).reshape(-1)
        if not samples.size:
            return
        with self._lock:
            self._samples += int(samples.size)
            rms = float(np.sqrt(np.mean(np.square(samples))))
            self._track_utterance(rms, samples.size)
            if self.include_audio:
                pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
                self._append(pcm)
            self._tick()

    def mark_discontinuity(self) -> None:
        """采集来源切换：上一路的语音边界不能拼进新来源的字幕。"""
        with self._lock:
            self._voiced = False
            self._silence = 0.0
            self._pending = None

    def _track_utterance(self, rms: float, frames: int) -> None:
        seconds = frames / float(self.sample_rate)
        end = self._samples / float(self.sample_rate)
        if rms >= SILENCE_RMS:
            if not self._voiced:
                self._voiced = True
                self._utterance_start = end - seconds
            self._silence = 0.0
            return
        if not self._voiced:
            return
        self._silence += seconds
        if self._silence >= SILENCE_SECONDS:
            stop = max(self._utterance_start + MIN_CUE_SECONDS, end - self._silence)
            self._pending = (self._utterance_start, stop)
            self._voiced = False
            self._silence = 0.0

    def _tick(self) -> None:
        """周期性把 WAV 头与会话清单刷到磁盘。

        正常情况下由 close() 统一收尾；但识别服务崩溃、被强杀或断电时不会走到
        close()。按秒回填文件头、按 5 秒刷新清单，崩溃后已录内容仍然可播放、
        时间与字幕索引也能对上，最多丢最后一个刷新间隔。
        """
        if self._closed:
            return
        now = time.monotonic()
        if self._sync_seconds and (now - self._last_sync_at) >= self._sync_seconds:
            self._sync_headers(force=True)
        if self._manifest_seconds and (now - self._last_manifest_at) >= self._manifest_seconds:
            self._last_manifest_at = now
            self._write_manifest("recording")

    def _sync_headers(self, force: bool = False) -> None:
        """把当前片段的 WAV 头长度回填到磁盘。

        wave 模块只在 close() 时补头，进程被强杀时头里的长度是 0，
        播放器会把它当成空文件。这里把 44 字节头中的 RIFF/data 长度
        按已写入字节数定期回填，保证崩溃后文件依然可用。
        """
        handle = self._wave
        if handle is None or not self._segment_path:
            return
        now = time.monotonic()
        if not force and (now - self._last_sync_at) < self._sync_seconds:
            return
        self._last_sync_at = now
        data_bytes = self._segment_bytes
        if data_bytes == self._patched_bytes:
            return
        try:
            source = getattr(handle, "_file", None)
            if source is not None:
                source.flush()
            with open(self._segment_path, "r+b") as patch:
                patch.seek(4)
                patch.write(struct.pack("<I", 36 + data_bytes))
                patch.seek(40)
                patch.write(struct.pack("<I", data_bytes))
            self._patched_bytes = data_bytes
        except Exception as exc:
            self._log("回填录音片段头失败：", repr(exc))

    def _append(self, pcm: bytes) -> None:
        frames = len(pcm) // 2
        limit = self.segment_seconds * self.sample_rate * 2
        if self._wave is None or self._segment_bytes >= limit:
            self._rotate(max(0, self._samples - frames))
        try:
            self._wave.writeframes(pcm)
            self._segment_bytes += len(pcm)
        except Exception as exc:  # 磁盘满 / 目录被删：不拖垮识别
            self._log("写录音片段失败：", repr(exc))

    def _rotate(self, start_sample: int) -> None:
        self._close_segment()
        self._segment_index += 1
        stamp = self._clock()
        name = f"seg-{self._segment_index:04d}-{stamp.strftime('%Y%m%d-%H%M%S')}.wav"
        os.makedirs(os.path.join(self.directory, "audio"), exist_ok=True)
        path = os.path.join(self.directory, "audio", name)
        handle = wave.open(path, "wb")
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(self.sample_rate)
        self._wave = handle
        self._segment_path = path
        self._patched_bytes = -1
        self._last_sync_at = 0.0
        self._segment_bytes = 0
        self._segment_started = stamp
        self.segments.append({
            "index": self._segment_index,
            "file": os.path.join("audio", name),
            "startedAt": stamp.isoformat(timespec="seconds"),
            "startSeconds": round(start_sample / float(self.sample_rate), 3),
        })
        self._write_manifest("recording")

    def _close_segment(self) -> None:
        handle = self._wave
        if handle is None:
            return
        # 先把已写数据长度回填，再交给 wave.close() 做最终修正
        self._sync_headers(force=True)
        self._wave = None
        try:
            frames = handle.getnframes()
            handle.close()
            if self.segments:
                self.segments[-1]["endedAt"] = self._clock().isoformat(timespec="seconds")
                self.segments[-1]["durationSeconds"] = round(frames / float(self.sample_rate), 3)
            if frames == 0:
                # 空片段没有意义，删掉以免误导
                empty = os.path.join(self.directory, self.segments[-1]["file"]) if self.segments else ""
                self.segments.pop()
                self._segment_index -= 1
                if empty and os.path.exists(empty):
                    os.remove(empty)
        except Exception as exc:
            self._log("关闭录音片段失败：", repr(exc))
        finally:
            self._segment_path = ""
            self._patched_bytes = -1

    # ---- 字幕 ----

    def add_final(self, text: str) -> dict | None:
        text = " ".join(str(text or "").split())
        if not text or not self.directory or self._closed:
            return None
        with self._lock:
            end = self._samples / float(self.sample_rate)
            if self._pending is not None:
                start, stop = self._pending
                self._pending = None
            elif self._voiced:
                start, stop = self._utterance_start, end
            else:
                start, stop = max(0.0, end - FALLBACK_SECONDS), end
            if stop - start < MIN_CUE_SECONDS:
                stop = start + MIN_CUE_SECONDS
            cue = {
                "index": len(self._cues) + 1,
                "start": round(start, 3),
                "end": round(stop, 3),
                "text": text,
                "startedAt": self._iso(start),
                "endedAt": self._iso(stop),
            }
            self._cues.append(cue)
            self._write_subtitles()
            return cue

    def _iso(self, seconds: float) -> str:
        if self._started is None:
            return ""
        moment = self._started + timedelta(seconds=float(seconds))
        return moment.isoformat(timespec="milliseconds")

    def _write_subtitles(self) -> None:
        if not self.directory:
            return
        path = self.subtitle_path
        lines: list[str] = []
        if self.subtitle_format == "vtt":
            lines.extend(["WEBVTT", ""])
        for cue in self._cues:
            if self.subtitle_format == "vtt":
                lines.append(f"{_timestamp(cue['start'], '.')} --> {_timestamp(cue['end'], '.')}")
            else:
                lines.append(str(cue["index"]))
                lines.append(f"{_timestamp(cue['start'])} --> {_timestamp(cue['end'])}")
            lines.extend(cue["text"].splitlines() or [""])
            lines.append("")
        temporary = path + ".tmp"
        try:
            with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
                handle.write("\n".join(lines) + ("\n" if lines else ""))
            os.replace(temporary, path)
        except Exception as exc:
            self._log("写字幕文件失败：", repr(exc))

    # ---- 清单 ----

    def _write_manifest(self, status: str) -> dict:
        now = self._clock()
        payload = {
            "version": 1,
            "status": status,
            "startedAt": self._started.isoformat(timespec="seconds") if self._started else "",
            "updatedAt": now.isoformat(timespec="seconds"),
            "endedAt": None if status == "recording" else now.isoformat(timespec="seconds"),
            "durationSeconds": round(self._samples / float(self.sample_rate), 3),
            "engine": self.engine,
            "source": {"kind": self.source_kind, "label": self.source_label},
            "audio": {
                "enabled": self.include_audio,
                "sampleRate": self.sample_rate,
                "channels": 1,
                "bitsPerSample": 16,
                "segmentSeconds": self.segment_seconds,
                "segments": self.segments,
            },
            "subtitles": {
                "format": self.subtitle_format,
                "file": os.path.basename(self.subtitle_path) if self.directory else "",
                "cues": len(self._cues),
            },
            "cues": self._cues,
        }
        if self.directory:
            path = os.path.join(self.directory, "session.json")
            temporary = path + ".tmp"
            try:
                with open(temporary, "w", encoding="utf-8") as handle:
                    json.dump(payload, handle, ensure_ascii=False, indent=2)
                os.replace(temporary, path)
            except Exception as exc:
                self._log("写会话清单失败：", repr(exc))
        self._manifest = payload
        return payload

    def summary(self) -> dict:
        return {
            "directory": self.directory,
            "subtitlePath": self.subtitle_path,
            "segments": len(self.segments),
            "cues": len(self._cues),
            "durationSeconds": round(self._samples / float(self.sample_rate), 3),
            "segmentSeconds": self.segment_seconds,
            "subtitleFormat": self.subtitle_format,
            "includeAudio": self.include_audio,
        }
