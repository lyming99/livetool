# -*- coding: utf-8 -*-
"""验证打包后的后端能否 import funasr / torch。"""

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
    time.sleep(3.0)  # 打包后 import 会慢一些

    for engine in ("funasr", "whisper"):
        proc.stdin.write(json.dumps({"type": "check_env", "engine": engine}) + "\n")
        proc.stdin.flush()
        time.sleep(4.0)

    proc.stdin.write(json.dumps({"type": "shutdown"}) + "\n")
    proc.stdin.flush()

    try:
        out, err = proc.communicate(timeout=20)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, err = proc.communicate()

    print("=" * 60)
    for line in out.splitlines():
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            print(line)
            continue
        if msg.get("type") == "env":
            deps = msg.get("deps", [])
            print(f"[{msg.get('engine')}] ready={msg.get('ready')}")
            for d in deps:
                flag = "OK" if d["installed"] else "MISSING"
                err = f"  <- {d.get('error')}" if d.get("error") else ""
                print(f"   {d['package']:<22} {flag}{err}")
        else:
            print(line)
    if err.strip():
        print("--- stderr ---")
        print(err.strip()[-2000:])
    print("=" * 60)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
