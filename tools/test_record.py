# -*- coding: utf-8 -*-
"""验证「录制 → 保存 wav → 识别」流程（不经过 Electron）。"""

from __future__ import annotations

import json
import os
import sys

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import main as backend_main

# 过滤掉 base64，避免刷屏
_orig_emit = backend_main.emit


def emit_filtered(obj):
    if isinstance(obj, dict) and obj.get("type") == "record_result":
        obj = {k: v for k, v in obj.items() if k != "wav"}
    _orig_emit(obj)


backend_main.emit = emit_filtered

cfg_path = os.path.join(os.environ.get("APPDATA", ""), "livetool", "config.json")
asr_cfg = {}
try:
    with open(cfg_path, "r", encoding="utf-8") as fh:
        asr_cfg = json.load(fh).get("asr", {})
except Exception as exc:
    print("读取配置失败:", exc)

print("配置:", json.dumps(asr_cfg, ensure_ascii=False))
print("开始录制 3 秒…")

backend = backend_main.Backend(mock=False)
backend.asr_config = asr_cfg
backend._do_record_test(3.0)

print("done")
