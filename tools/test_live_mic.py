# -*- coding: utf-8 -*-
"""用真实麦克风跑 FunAsrEngine，输出详细诊断信息。

不需要 Electron，直接验证「麦克风采集 + FunASR 推理」这条链路。
运行后会持续采集 3 分钟，期间正常说话即可。

用法: python tools/test_live_mic.py
"""

from __future__ import annotations

import json
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

# 读取应用当前配置（麦克风、模型、标点）
cfg_path = os.path.join(os.environ.get("APPDATA", ""), "livetool", "config.json")
asr_cfg = {}
try:
    with open(cfg_path, "r", encoding="utf-8") as fh:
        asr_cfg = json.load(fh).get("asr", {})
except Exception as exc:
    print("读取配置失败，用默认值:", exc)

print("配置：", json.dumps(asr_cfg, ensure_ascii=False))
print("麦克风设备索引:", asr_cfg.get("audioDevice"))

import sounddevice as sd

node = asr_cfg.get("audioDevice")
try:
    info = sd.query_devices(node, "input")
    print(f"设备：{info['name']}  原生采样率 {info['default_samplerate']}Hz")
except Exception as exc:
    print("查询设备失败:", exc)

from asr_engine import FunAsrEngine  # noqa: E402

# 屏蔽 funasr 的进度条和日志噪音（写 stderr），只保留识别结果
_DEVNULL = open(os.devnull, "w", encoding="utf-8")
sys.stderr = _DEVNULL

last_partial = ""
last_log = 0.0


def on_partial(text: str) -> None:
    global last_partial
    if text != last_partial:
        last_partial = text
        print(f"  [partial] {text}")


def on_final(text: str) -> None:
    global last_partial
    last_partial = ""
    print(f"[FINAL] {text}")


def on_status(state: str, detail: str = "") -> None:
    print(f"[STATUS] {state} {detail}")


engine = FunAsrEngine(config=asr_cfg, models_dir="")
engine.start(on_partial, on_final, on_status)

print("=" * 60)
print("开始采集，请对着麦克风正常说话（持续 3 分钟）")
print("=" * 60)

try:
    for i in range(300):
        time.sleep(1.0)
        if i % 15 == 14:
            print(f"... 已采集 {i + 1}s")
except KeyboardInterrupt:
    pass

engine.stop()
print("=" * 60)
print("结束")
