# -*- coding: utf-8 -*-
"""验证识别可重复调用：第一次含模型加载，第二次应该明显更快。"""

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

import main as backend_main

cfg_path = os.path.join(os.environ.get("APPDATA", ""), "livetool", "config.json")
asr_cfg = {}
try:
    with open(cfg_path, "r", encoding="utf-8") as fh:
        asr_cfg = json.load(fh).get("asr", {})
except Exception as exc:
    print("读取配置失败:", exc)

wav = os.path.join(os.environ.get("APPDATA", ""), "livetool", "test_recording.wav")
print("录音文件:", wav, "存在:", os.path.exists(wav))

backend = backend_main.Backend(mock=False)
backend.asr_config = asr_cfg

# 屏蔽 funasr 噪音
sys.stderr = open(os.devnull, "w", encoding="utf-8")

for i in (1, 2):
    print(f"--- 第 {i} 次识别 ---")
    t0 = time.time()
    backend._do_recognize_test()
    print(f"总耗时 {time.time() - t0:.2f}s")
