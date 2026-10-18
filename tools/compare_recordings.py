# -*- coding: utf-8 -*-
"""分别用「系统默认」和「WASAPI NX6」录 2 秒，存成 wav 对比。

如果两个文件的时长都≈2.00s，说明采样率没问题，变音另有原因。
"""

from __future__ import annotations

import os
import sys

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass

import numpy as np
import soundfile as sf
import sounddevice as sd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CASES = [("default", None), ("wasapi23", 23)]


def record(device, seconds=2.0):
    info = sd.query_devices(device, "input")
    sr = int(info.get("default_samplerate") or 44100)
    block = 1024
    need = int(seconds * sr)

    stream = sd.InputStream(
        samplerate=sr, channels=1, dtype="float32", blocksize=block, device=device
    )
    stream.start()
    actual = int(round(stream.samplerate))
    chunks = []
    got = 0
    while got < need:
        data, _o = stream.read(block)
        take = min(block, need - got)
        chunks.append(data[:take, 0].copy())
        got += take
    stream.stop()
    stream.close()

    audio = np.concatenate(chunks)
    return audio, sr, actual, info.get("name", "")


for label, dev in CASES:
    try:
        audio, sr, actual, name = record(dev)
    except Exception as exc:
        print(f"{label}: 失败 {type(exc).__name__}: {exc}")
        continue

    path = os.path.join(ROOT, f"probe_{label}.wav")
    sf.write(path, audio, sr, subtype="PCM_16")

    info_read = sf.info(path)
    peak = float(np.sqrt(np.mean(np.square(audio))))
    zero_crossings = int(np.sum(np.abs(np.diff(np.signbit(audio)))))

    print(
        f"{label:<10} device={dev!s:<4} name={name[:22]:<24} "
        f"报告={sr} 实际={actual} 样本={len(audio)} "
        f"写入时长={len(audio)/sr:.3f}s 读回={info_read.duration:.3f}s "
        f"peak={peak:.4f} 过零={zero_crossings}"
    )
    print(f"           文件: {path}")

print("=" * 90)
print("对比：若两个文件的「读回」时长都是 2.000s，说明采样率没错，变音另有原因。")
print("再过零次数：正常语音应该在同一量级（几百到几千）。差一个数量级说明波形异常。")
