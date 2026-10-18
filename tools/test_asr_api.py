# -*- coding: utf-8 -*-
"""用真实音频验证 FunASR 流式 API 的行为。

要确认三件事：
  1. 每次 generate 返回的是「本块增量」还是「整句累计」
  2. is_final=True 对最后一段的影响
  3. 单块推理耗时（决定延迟能不能接受）
"""

from __future__ import annotations

import os
import sys
import time

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(ROOT, "models")

import numpy as np
import soundfile as sf
from funasr import AutoModel

CHUNK = [0, 10, 5]
STRIDE = CHUNK[1] * 960


def main() -> None:
    print("加载 paraformer-zh-streaming（首次会下载约 1GB）...")
    t0 = time.time()
    model = AutoModel(
        model="paraformer-zh-streaming",
        model_revision="v2.0.4",
        cache_dir=MODEL_DIR,
        disable_update=True,
        device="cpu",
    )
    print(f"模型加载完成，耗时 {time.time() - t0:.1f}s")

    audio, sr = sf.read(os.path.join(ROOT, "test_audio.wav"), dtype="float32")
    print(f"音频时长 {len(audio)/sr:.2f}s, 采样率 {sr}")

    cache: dict = {}
    total = int(len(audio) / STRIDE) + 1
    accum = ""

    for i in range(total):
        seg = audio[i * STRIDE:(i + 1) * STRIDE]
        is_final = i == total - 1
        t = time.time()
        res = model.generate(
            input=seg,
            cache=cache,
            is_final=is_final,
            chunk_size=CHUNK,
            encoder_chunk_look_back=4,
            decoder_chunk_look_back=1,
        )
        dt = (time.time() - t) * 1000
        text = res[0].get("text", "") if res else ""
        accum += text
        print(f"[{i:02d}] final={int(is_final)} {dt:5.0f}ms chunk={text!r}")
        print(f"     accum={accum!r}")

    print("=" * 50)
    print("最终文本:", accum)


if __name__ == "__main__":
    main()
