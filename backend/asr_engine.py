# -*- coding: utf-8 -*-
"""FunASR 流式识别引擎。

用真实音频验证过的 API 行为（tools/test_asr_api.py）：
  - generate() 每块返回的是「本块增量」文本，需要自己累加
  - is_final=True 的那一块返回空串，作用是收尾并释放 cache
  - 600ms 一块，单块推理约 120~160ms（CPU），RTF 约 0.2

所以这里的设计是：
  1. 一直用 is_final=False 跑增量，拼成当前句
  2. 检测到静音够久，再补一块 is_final=True 收尾，然后清 cache 开始下一句
  3. 任何异常都通过 on_status 报出来，绝不让线程静默退出
"""

from __future__ import annotations

import os
import sys
import threading
import time

SAMPLE_RATE = 16000
# [0, 10, 5]：每块 10*60ms = 600ms，左右各留一点上下文
CHUNK_SIZE = [0, 10, 5]
ENCODER_LOOK_BACK = 4
DECODER_LOOK_BACK = 1
CHUNK_SAMPLES = CHUNK_SIZE[1] * 960  # 9600 samples = 600ms @ 16k
BLOCK_SECONDS = CHUNK_SAMPLES / SAMPLE_RATE

# Media Foundation 直接提供 16k PCM16，按 100ms 读取，再攒够模型的 600ms 块。
READ_FRAMES = 1600

# 判定「这一块有人在说话」的 RMS 阈值（float32，范围 -1~1）
SILENCE_RMS = 0.004
# 连续静音多久算一句结束
SILENCE_SECONDS = 0.7
# 启动后多久还没检测到声音就提示用户
NO_SIGNAL_SECONDS = 3.0
NO_SIGNAL_RMS = 0.001

# 采集来源对应的运行状态文案
CAPTURE_STATUS = {
    "input": "Media Foundation · 16kHz PCM16 麦克风采集中",
    "output": "WASAPI 环回 · 16kHz PCM16 电脑声音采集中",
}
CAPTURE_NO_SIGNAL = {
    "input": "没有检测到麦克风声音，请检查设备选择或系统权限",
    "output": "没有检测到电脑声音，请确认系统正在播放声音并检查扬声器选择",
}
CAPTURE_INTERRUPTED = {
    "input": "原生麦克风采集中断：",
    "output": "电脑声音采集中断：",
}


class FunAsrEngine:
    def __init__(self, config: dict | None = None, models_dir: str = "") -> None:
        cfg = config or {}
        explicit_cache = (cfg.get("cacheDir") or "").strip()
        self.models_dir = explicit_cache or models_dir
        # 用户是否显式指定了缓存目录，决定要不要覆盖 modelscope 的默认位置
        self.explicit_cache = bool(explicit_cache)
        self.model = (cfg.get("model") or "paraformer-zh-streaming").strip()
        self.model_revision = (cfg.get("modelRevision") or "").strip()
        self.model_path = (cfg.get("modelPath") or "").strip()
        self.punc_model = (cfg.get("puncModel") or "ct-punc").strip()
        self.use_punc = cfg.get("usePunc", True) is not False
        self.device = (cfg.get("device") or "cpu").strip()
        # 采集来源：input = 麦克风（MF endpoint），output = 电脑声音（WASAPI 环回）
        from audio_devices import capture_target
        target = capture_target(cfg)
        self.capture_kind = target["kind"]
        self.audio_device = target["device"]
        self.capture_label = target["label"]

        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._capture = None
        self._asr = None
        self._punc = None

    # ---- 日志 ----

    @staticmethod
    def _log(msg: str) -> None:
        print(f"[funasr] {msg}", file=sys.stderr, flush=True)

    # ---- 生命周期 ----

    def start(self, on_partial, on_final, on_status) -> None:
        if self._stop.is_set():
            return
        self._resolve_device(on_status)
        on_status("loading", "正在加载 FunASR 模型，首次运行需下载约 1GB")
        self._load_models()
        if self._stop.is_set():
            return
        self._thread = threading.Thread(
            target=self._run,
            args=(on_partial, on_final, on_status),
            daemon=True,
            name="funasr-stream",
        )
        self._thread.start()

    def _resolve_device(self, on_status) -> None:
        """选了 GPU 但 torch 不支持 CUDA 时，直接回退 CPU。

        安装包内置的是 CPU 版 torch，用户误选 cuda:0 会卡在加载。
        """
        if self.device == "cpu":
            return
        try:
            import torch

            if not torch.cuda.is_available():
                self._log(f"设备 {self.device} 不可用（torch 未启用 CUDA），回退 CPU")
                self.device = "cpu"
                on_status("starting", "GPU 不可用（当前是 CPU 版 torch），已回退 CPU")
        except Exception as exc:
            self._log(f"检查 CUDA 失败，回退 CPU：{exc!r}")
            self.device = "cpu"

    def stop(self) -> None:
        self._stop.set()
        capture = self._capture
        if capture is not None:
            capture.close()
        thread = self._thread
        if thread is not None and thread.ident is not None and thread is not threading.current_thread():
            thread.join(timeout=3.0)
        if thread is None or not thread.is_alive():
            self._thread = None

    # ---- 模型 ----

    def _load_models(self) -> None:
        from funasr import AutoModel

        # funasr 实际是通过 modelscope 下载模型的，cache_dir 参数不一定生效。
        # 只有用户显式填了缓存目录才设环境变量；留空时沿用 modelscope 默认缓存
        # （%USERPROFILE%\.cache\modelscope），这样之前下过的模型能直接复用。
        if self.explicit_cache:
            os.environ.setdefault("MODELSCOPE_CACHE", self.models_dir)

        target = self.model_path or self.model
        kwargs = {
            "model": target,
            "cache_dir": self.models_dir,
            "disable_update": True,
            "device": self.device,
        }
        if self.model_revision and not self.model_path:
            kwargs["model_revision"] = self.model_revision

        t0 = time.time()
        # AutoModel 下载/加载时会往 stdout 打印版本号和下载地址，
        # 同样会破坏 JSON 协议，这里一并改道到 stderr
        import contextlib

        with contextlib.redirect_stdout(sys.stderr):
            self._asr = AutoModel(**kwargs)
        self._log(f"ASR 模型就绪，耗时 {time.time() - t0:.1f}s")

        if self.use_punc:
            try:
                t1 = time.time()
                with contextlib.redirect_stdout(sys.stderr):
                    self._punc = AutoModel(
                        model=self.punc_model,
                        cache_dir=self.models_dir,
                        disable_update=True,
                        device=self.device,
                    )
                self._log(f"标点模型就绪，耗时 {time.time() - t1:.1f}s")
            except Exception as exc:
                # 标点失败不该拖垮整个识别
                self._log(f"标点模型加载失败，将不添加标点：{exc!r}")
                self._punc = None

    def _add_punc(self, text: str) -> str:
        if not self._punc or not text:
            return text
        try:
            res = self._punc.generate(input=text)
            if res and res[0].get("text"):
                return res[0]["text"]
        except Exception as exc:
            self._log(f"标点处理失败：{exc!r}")
        return text

    def _transcribe_chunk(self, audio, cache: dict, is_final: bool = False) -> str:
        import contextlib

        # funasr 在 generate 里会往 stdout 打印进度条/统计信息，
        # 而 stdout 是给 Electron 传 JSON 协议的通道，必须全部改道到 stderr，
        # 否则 JSON 会被污染，状态和字幕都传不出去。
        with contextlib.redirect_stdout(sys.stderr):
            res = self._asr.generate(
                input=audio,
                cache=cache,
                is_final=is_final,
                chunk_size=CHUNK_SIZE,
                encoder_chunk_look_back=ENCODER_LOOK_BACK,
                decoder_chunk_look_back=DECODER_LOOK_BACK,
            )
        if not res:
            return ""
        return "".join(item.get("text", "") for item in res)

    # ---- 采集与识别 ----

    def _run(self, on_partial, on_final, on_status) -> None:
        import numpy as np
        from mf_stream import PcmInputStream

        stream = PcmInputStream(self.audio_device, kind=self.capture_kind,
                                sample_rate=SAMPLE_RATE, stop_event=self._stop)
        self._capture = stream
        cache: dict = {}
        buffer = ""
        pending = np.zeros(0, dtype=np.float32)
        silent_seconds = 0.0
        elapsed = 0.0
        peak_rms = 0.0
        voiced = False
        no_signal_reported = False
        block_seconds = BLOCK_SECONDS

        try:
            stream.start()
            on_status("running", CAPTURE_STATUS[self.capture_kind])
            while not self._stop.is_set():
                audio16 = stream.read(READ_FRAMES)
                if not audio16.size:
                    break

                pending = (
                    np.concatenate([pending, audio16]) if pending.size else audio16
                )

                # 流式模型要求固定 600ms 一块，所以攒够再送
                while len(pending) >= CHUNK_SAMPLES and not self._stop.is_set():
                    chunk = np.ascontiguousarray(pending[:CHUNK_SAMPLES])
                    pending = pending[CHUNK_SAMPLES:]

                    rms = float(np.sqrt(np.mean(np.square(chunk)))) if chunk.size else 0.0
                    peak_rms = max(peak_rms, rms)
                    elapsed += block_seconds

                    try:
                        piece = self._transcribe_chunk(chunk, cache, is_final=False)
                    except Exception as exc:
                        self._log(f"推理失败：{exc!r}")
                        on_status("running", f"识别出错：{exc}")
                        piece = ""

                    if piece:
                        buffer += piece
                        on_partial(buffer)

                    if rms >= SILENCE_RMS:
                        silent_seconds = 0.0
                        voiced = True
                    else:
                        silent_seconds += block_seconds

                    if (not no_signal_reported and not voiced
                            and elapsed >= NO_SIGNAL_SECONDS and peak_rms < NO_SIGNAL_RMS):
                        no_signal_reported = True
                        self._log(f"没有检测到输入信号，peak_rms={peak_rms:.5f}")
                        on_status("running", CAPTURE_NO_SIGNAL[self.capture_kind])

                    if voiced and silent_seconds >= SILENCE_SECONDS and buffer:
                        try:
                            tail = self._transcribe_chunk(
                                np.zeros(CHUNK_SAMPLES, dtype=np.float32), cache, is_final=True
                            )
                            if tail:
                                buffer += tail
                        except Exception as exc:
                            self._log(f"收尾失败：{exc!r}")

                        final_text = self._add_punc(buffer)
                        if final_text:
                            on_final(final_text)
                        on_partial("")

                        buffer = ""
                        cache = {}
                        voiced = False
                        silent_seconds = 0.0
        except Exception as exc:
            if not self._stop.is_set():
                self._log(f"采集循环异常退出：{exc!r}")
                on_status("error", f"{CAPTURE_INTERRUPTED[self.capture_kind]}{exc}")
        finally:
            stream.close()
            self._capture = None
            self._log(f"{self.capture_label}采集已关闭")
