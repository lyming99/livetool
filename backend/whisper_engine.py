# -*- coding: utf-8 -*-
"""Whisper 本地识别引擎（faster-whisper / CTranslate2）。

和 FunASR 的流式 Paraformer 不同，Whisper 本身不是流式模型，只能「一段一段」
转写。所以这里的策略是：

  - 说话过程中，每 1.2 秒把最近 3 秒音频丢给模型转一次，结果作为草稿（partial）
  - 检测到静音 0.6 秒，把整句再转一次，作为定稿（final）

代价是延迟比 FunASR 高（1.5~2.5 秒），CPU 占用也更大；优点是模型小、
多语种、离线可用。

采集和转写分成两个线程：采集线程只管把音频塞进队列，转写线程阻塞也不会
导致音频丢失。
"""

from __future__ import annotations

import os
import queue
import threading
import time

SAMPLE_RATE = 16000
BLOCK_SAMPLES = 1600            # 100ms 一块
PARTIAL_INTERVAL = 1.2          # 草稿转写间隔（秒）
PARTIAL_WINDOW = 3.0            # 草稿只看最近 3 秒
SILENCE_RMS = 0.006
SILENCE_SECONDS = 0.6
MAX_UTTERANCE = 12.0            # 单句最长，超过就强制定稿
MIN_UTTERANCE = 0.4             # 短于这个长度的不转写

# 采集来源对应的运行状态与故障文案（与 FunASR 引擎保持一致）
CAPTURE_STATUS = {
    "input": "Media Foundation · 16kHz PCM16 麦克风采集中",
    "output": "WASAPI 环回 · 16kHz PCM16 电脑声音采集中",
}
CAPTURE_INTERRUPTED = {
    "input": "原生麦克风采集中断：",
    "output": "电脑声音采集中断：",
}


class WhisperEngine:
    def __init__(self, config: dict | None = None, models_dir: str = "") -> None:
        cfg = config or {}
        self.model_size = (cfg.get("whisperModel") or "small").strip()
        self.compute_type = (cfg.get("computeType") or "int8").strip()
        self.infer_device = (cfg.get("device") or "cpu").strip()
        # 采集来源：input = 麦克风，output = 电脑声音（WASAPI 环回）
        from audio_devices import capture_target
        target = capture_target(cfg)
        self.capture_kind = target["kind"]
        self.audio_device = target["device"]
        self.capture_label = target["label"]
        self.cache_root = (cfg.get("cacheDir") or "").strip() or models_dir
        self.language = (cfg.get("language") or "zh").strip()

        self._model = None
        self._capture = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._reader: threading.Thread | None = None
        self._audio_q: queue.Queue = queue.Queue(maxsize=200)
        # 运行中切换采集来源：只换底层流，已加载的模型继续用
        self._switch_lock = threading.Lock()
        self._capture_version = 0

    # ---- 生命周期 ----

    def start(self, on_partial, on_final, on_status) -> None:
        if self._stop.is_set():
            return
        on_status("loading", f"正在加载 Whisper 模型（{self.model_size}）")
        self._load()
        if self._stop.is_set():
            return
        self._thread = threading.Thread(
            target=self._run, args=(on_partial, on_final, on_status), daemon=True, name="whisper-asr"
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        capture = self._capture
        if capture is not None:
            capture.close()
        for thread in (self._reader, self._thread):
            if thread is not None and thread.ident is not None and thread is not threading.current_thread():
                thread.join(timeout=3.0)
        if self._thread is None or not self._thread.is_alive():
            self._thread = None
        if self._reader is None or not self._reader.is_alive():
            self._reader = None

    # ---- 模型 ----

    def _load(self) -> None:
        from faster_whisper import WhisperModel

        download_root = os.path.join(self.cache_root, "whisper")
        local_dir = os.path.join(download_root, f"faster-whisper-{self.model_size}")
        has_local = os.path.exists(os.path.join(local_dir, "model.bin"))

        self._model = WhisperModel(
            local_dir if has_local else self.model_size,
            device=self.infer_device,
            compute_type=self.compute_type,
            download_root=download_root,
        )

    def _transcribe(self, audio) -> str:
        segments, _info = self._model.transcribe(
            audio,
            language=None if self.language == "auto" else self.language,
            beam_size=1,
            vad_filter=False,
            condition_on_previous_text=False,
            without_timestamps=True,
        )
        return "".join(seg.text for seg in segments).strip()

    # ---- 采集与识别 ----

    def switch_capture(self, kind: str, device=None) -> dict:
        """运行中切换采集来源（麦克风 <-> 电脑声音），不重载已加载的模型。"""
        from mf_stream import switch_engine_capture

        return switch_engine_capture(self, kind, device)

    def _read_loop(self, on_status) -> None:
        from mf_stream import SwitchablePcmStream

        stream = SwitchablePcmStream(self.audio_device, kind=self.capture_kind,
                                     sample_rate=SAMPLE_RATE, stop_event=self._stop)
        self._capture = stream
        try:
            stream.start()
            on_status("running", CAPTURE_STATUS[self.capture_kind])
            while not self._stop.is_set():
                audio = stream.read(BLOCK_SAMPLES)
                if not audio.size:
                    break
                try:
                    self._audio_q.put_nowait(audio)
                except queue.Full:
                    # Keep the existing bounded inference queue policy, never switch capture APIs.
                    try:
                        self._audio_q.get_nowait()
                        self._audio_q.put_nowait(audio)
                    except (queue.Empty, queue.Full):
                        pass
        except Exception as exc:
            if not self._stop.is_set():
                on_status("error", f"{CAPTURE_INTERRUPTED[self.capture_kind]}{exc}")
            self._stop.set()
        finally:
            stream.close()
            self._capture = None

    def _run(self, on_partial, on_final, on_status) -> None:
        import numpy as np

        self._reader = threading.Thread(target=self._read_loop, args=(on_status,), daemon=True, name="whisper-audio")
        self._reader.start()

        buffer = np.zeros(0, dtype=np.float32)      # 最近几秒，用于草稿
        pending = np.zeros(0, dtype=np.float32)     # 当前整句，用于定稿
        silence = 0.0
        last_partial = 0.0
        capture_version = self._capture_version

        window_samples = int(SAMPLE_RATE * PARTIAL_WINDOW)
        max_samples = int(SAMPLE_RATE * MAX_UTTERANCE)

        while not self._stop.is_set():
            if self._capture_version != capture_version:
                # 采集来源刚换过：上一路残留的音频不能拼进新来源的句子
                capture_version = self._capture_version
                buffer = np.zeros(0, dtype=np.float32)
                pending = np.zeros(0, dtype=np.float32)
                silence = 0.0
                last_partial = 0.0
                on_partial("")
                on_status("running", CAPTURE_STATUS[self.capture_kind])

            try:
                audio = self._audio_q.get(timeout=0.2)
            except queue.Empty:
                continue

            buffer = np.concatenate([buffer, audio])[-window_samples:]
            pending = np.concatenate([pending, audio])[-max_samples:]

            rms = float(np.sqrt(np.mean(np.square(audio)))) if audio.size else 0.0
            now = time.monotonic()

            if rms >= SILENCE_RMS:
                silence = 0.0
                # 说话中，隔一段时间出一版草稿
                if now - last_partial >= PARTIAL_INTERVAL and len(buffer) > SAMPLE_RATE * 0.8:
                    last_partial = now
                    try:
                        text = self._transcribe(buffer)
                    except Exception as exc:
                        on_status("running", f"转写失败：{exc}")
                        continue
                    if text:
                        on_partial(text)
            else:
                silence += BLOCK_SAMPLES / SAMPLE_RATE
                if silence >= SILENCE_SECONDS and len(pending) >= SAMPLE_RATE * MIN_UTTERANCE:
                    try:
                        text = self._transcribe(pending)
                    except Exception as exc:
                        on_status("running", f"转写失败：{exc}")
                        text = ""
                    if text:
                        on_final(text)
                    pending = np.zeros(0, dtype=np.float32)
                    buffer = np.zeros(0, dtype=np.float32)
                    on_partial("")
                    silence = 0.0
