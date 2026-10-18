# -*- coding: utf-8 -*-
"""逐个打开所有输入设备，测 1 秒峰值电平，找出哪个麦克风真的有声音。

用法: python tools/scan_mics.py
运行期间请持续说话。
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
sys.path.insert(0, os.path.join(ROOT, "backend"))

import numpy as np
import sounddevice as sd

from audio_devices import list_input_devices

devices = list_input_devices()
print(f"共 {len(devices)} 个输入设备，开始扫描（每轮约 {len(devices)} 秒）")
print("请持续说话！")
print("=" * 60)

results: dict[int, float] = {}

for round_no in range(1, 4):
    print(f"--- 第 {round_no} 轮 ---")
    for dev in devices:
        idx = dev["index"]
        name = dev["name"][:28]
        try:
            info = sd.query_devices(idx, "input")
            sr = int(info["default_samplerate"]) or 44100
            block = 1024
            frames = int(1.0 * sr / block)

            stream = sd.InputStream(
                samplerate=sr, channels=1, dtype="float32", blocksize=block, device=idx
            )
            stream.start()
            peak = 0.0
            try:
                for _ in range(frames):
                    data, _o = stream.read(block)
                    if data.size:
                        peak = max(peak, float(np.sqrt(np.mean(np.square(data[:, 0])))))
            finally:
                stream.stop()
                stream.close()

            results[idx] = max(results.get(idx, 0.0), peak)
            flag = "  <== 有信号" if peak > 0.01 else ""
            print(f"  [{idx:3d}] {name:<30} peak={peak:.4f}{flag}")
        except Exception as exc:
            print(f"  [{idx:3d}] {name:<30} 打不开: {type(exc).__name__}")

print("=" * 60)
ranked = sorted(results.items(), key=lambda kv: kv[1], reverse=True)
print("峰值排行：")
for idx, peak in ranked[:6]:
    dev = next((d for d in devices if d["index"] == idx), None)
    name = dev["name"][:30] if dev else "?"
    print(f"  {peak:.4f}  设备 {idx}  {name}")
