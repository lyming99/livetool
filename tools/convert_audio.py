# -*- coding: utf-8 -*-
"""把 Windows SAPI 生成的 wav 转成 16k 单声道，供 ASR 测试使用。"""

from __future__ import annotations

import sys
from math import gcd

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

SRC = "test_raw.wav"
DST = "test_audio.wav"

audio, sr = sf.read(SRC, dtype="float32")
if audio.ndim > 1:
    audio = audio.mean(axis=1)

if sr != 16000:
    g = gcd(sr, 16000)
    audio = resample_poly(audio, 16000 // g, sr // g).astype(np.float32)

sf.write(DST, audio, 16000, subtype="PCM_16")
print(f"{SRC} ({sr} Hz) -> {DST} (16000 Hz), 时长 {len(audio)/16000:.2f}s")
