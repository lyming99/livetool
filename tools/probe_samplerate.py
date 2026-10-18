# -*- coding: utf-8 -*-
"""对比各输入设备的「报告采样率」和「实际打开后的采样率」。

变音 = 采样率假设错误。蓝牙耳机的 WASAPI 经常报 44100 实际跑 48000/16000。
"""

from __future__ import annotations

import sys

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass

import numpy as np
import sounddevice as sd

TARGETS = [None, 23, 24, 0]


def probe(device) -> None:
    try:
        info = sd.query_devices(device, "input")
    except Exception as exc:
        print(f"device={device}: 查询失败 {exc}")
        return

    reported = int(info.get("default_samplerate") or 0)
    name = info.get("name", "")[:26]

    try:
        stream = sd.InputStream(
            samplerate=reported,
            channels=1,
            dtype="float32",
            blocksize=1024,
            device=device,
        )
        stream.start()
        actual = int(round(stream.samplerate))
        frames = []
        need = int(2.0 * actual)
        got = 0
        while got < need:
            data, _o = stream.read(1024)
            frames.append(data[:, 0])
            got += len(data)
        stream.stop()
        stream.close()
    except Exception as exc:
        print(f"device={device} {name}: 打开失败 {type(exc).__name__}: {exc}")
        return

    audio = np.concatenate(frames)
    peak = float(np.sqrt(np.mean(np.square(audio)))) if audio.size else 0.0

    print(
        f"device={device!s:<4} {name:<28} "
        f"报告={reported:<6} 实际={actual:<6} "
        f"样本数={len(audio):<7} "
        f"按实际={len(audio)/actual:.2f}s 按报告={len(audio)/reported:.2f}s "
        f"peak={peak:.4f}"
    )


print("=" * 100)
for dev in TARGETS:
    probe(dev)
print("=" * 100)
print("如果「按实际」≈2.00s 而「按报告」明显偏离，说明报告的采样率是错的。")
