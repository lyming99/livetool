# -*- coding: utf-8 -*-
"""验证打包环境里 funasr tokenizer 能正常实例化（复现过 NameError 的路径）。"""

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
    time.sleep(3.0)

    proc.stdin.write(json.dumps({"type": "selftest"}) + "\n")
    proc.stdin.flush()
    time.sleep(10.0)

    proc.stdin.write(json.dumps({"type": "shutdown"}) + "\n")
    proc.stdin.flush()

    try:
        out, err = proc.communicate(timeout=20)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, err = proc.communicate()

    result = None
    for line in out.splitlines():
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("type") == "selftest":
            result = msg

    print("=" * 56)
    if result is None:
        print("没有收到 selftest 响应")
        if err.strip():
            print("--- stderr ---")
            print(err.strip()[-1500:])
        print("结果: FAIL")
        return 1

    print("ok     :", result.get("ok"))
    print("detail :", result.get("detail"))
    print("=" * 56)
    print("结果:", "PASS" if result.get("ok") else "FAIL")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
