# -*- coding: utf-8 -*-
"""验证自动安装流程：检查依赖 -> 下载模型。

用法: python tools/test_install.py whisper tiny
"""

from __future__ import annotations

import os
import sys

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from installer import check_env, run_install  # noqa: E402


def main() -> int:
    engine = sys.argv[1] if len(sys.argv) > 1 else "whisper"
    model = sys.argv[2] if len(sys.argv) > 2 else "tiny"

    print("=" * 60)
    print("检查环境：", check_env(engine))
    print("=" * 60)

    config = {
        "whisperModel": model,
        "model": "paraformer-zh-streaming",
        "modelRevision": "v2.0.4",
        "puncModel": "ct-punc",
        "usePunc": False,
        "cacheDir": "",
    }

    ok = run_install(
        engine,
        config,
        os.path.join(ROOT, "models"),
        lambda msg: print("[install]", msg),
    )

    print("=" * 60)
    print("结果:", "成功" if ok else "失败")
    print("=" * 60)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
