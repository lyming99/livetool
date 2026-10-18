# -*- coding: utf-8 -*-
"""用 wav 文件模拟麦克风，跑通 FunAsrEngine 的完整链路。

默认模拟 16k 设备；加 --native 参数可模拟 44.1k 的 WASAPI 设备，
用来验证重采样分支（对应 paInvalidSampleRate 那个问题）。
"""

from __future__ import annotations

import os
import sys
import time
from math import gcd

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

NATIVE = 44100 if "--native" in sys.argv else 16000

audio, sr = sf.read(os.path.join(ROOT, "test_audio.wav"), dtype="float32")
assert sr == 16000
lead = np.zeros(int(16000 * 0.8), dtype=np.float32)
tail = np.zeros(int(16000 * 1.5), dtype=np.float32)
mono16 = np.concatenate([lead, audio, tail])

if NATIVE != 16000:
    g = gcd(16000, NATIVE)
    stream_data = resample_poly(mono16, NATIVE // g, 16000 // g).astype(np.float32)
else:
    stream_data = mono16

import sounddevice as sd


class FakeStream:
    def __init__(self, data: np.ndarray):
        self.data = data
        self.pos = 0

    def start(self):
        pass

    def stop(self):
        pass

    def close(self):
        pass

    def read(self, n):
        seg = self.data[self.pos:self.pos + n]
        self.pos += n
        if len(seg) < n:
            seg = np.pad(seg, (0, n - len(seg)))
        return seg.reshape(-1, 1), False


sd.InputStream = lambda **kw: FakeStream(stream_data)
sd.query_devices = lambda *a, **kw: {
    "default_samplerate": NATIVE,
    "max_input_channels": 1,
    "name": "fake",
}

from asr_engine import FunAsrEngine  # noqa: E402

partials: list[str] = []
finals: list[str] = []
statuses: list[tuple[str, str]] = []


def on_partial(text: str) -> None:
    partials.append(text)


def on_final(text: str) -> None:
    finals.append(text)
    print(f"[FINAL] {text}")


def on_status(state: str, detail: str = "") -> None:
    statuses.append((state, detail))
    print(f"[STATUS] {state} {detail}")


engine = FunAsrEngine(
    config={
        "model": "paraformer-zh-streaming",
        "modelRevision": "v2.0.4",
        "usePunc": False,
        "device": "cpu",
        "audioDevice": None,
    },
    models_dir="",
)

print(f"模拟设备采样率: {NATIVE}Hz")
engine.start(on_partial, on_final, on_status)
time.sleep(14)
engine.stop()

print("=" * 56)
print(f"partial 次数: {len(partials)}")
print(f"最后一次 partial: {partials[-1] if partials else None!r}")
print(f"final 条数: {len(finals)}")
for f in finals:
    print("  -", f)

ok = bool(finals) and "实时字幕" in "".join(finals)
print("结果:", "PASS" if ok else "FAIL")
