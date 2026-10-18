# -*- coding: utf-8 -*-
"""验证安装版（frozen）下选 FunASR 会自动回退到 Whisper。"""

from __future__ import annotations

import json
import subprocess
import sys
import time

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass

EXE = r"build\livetool-backend\livetool-backend.exe"


def main() -> int:
    proc = subprocess.Popen(
        [EXE],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )

    assert proc.stdin is not None
    time.sleep(2.0)

    # 故意选 funasr，安装版应该自动回退
    proc.stdin.write(json.dumps({
        "type": "start",
        "asr": {"engine": "funasr", "whisperModel": "tiny"},
    }) + "\n")
    proc.stdin.flush()

    time.sleep(10.0)

    proc.stdin.write(json.dumps({"type": "shutdown"}) + "\n")
    proc.stdin.flush()

    try:
        out, err = proc.communicate(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, err = proc.communicate()

    print("=" * 56)
    print(out.strip()[:2000])
    if err.strip():
        print("--- stderr ---")
        print(err.strip()[:1000])
    print("=" * 56)

    ok = "安装版不支持 FunASR" in out and "whisper" in out.lower()
    print("结果:", "PASS（已回退 Whisper）" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
