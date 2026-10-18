# -*- coding: utf-8 -*-
"""冒烟测试：验证 Python sidecar 的 stdio JSON 行协议。

用法: python tools/smoke_test.py
不依赖 Electron，也不依赖模型（走 --mock）。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


def main() -> int:
    env = {
        **os.environ,
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
        "PYTHONUNBUFFERED": "1",
    }
    proc = subprocess.Popen(
        [sys.executable, "backend/main.py", "--mock"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        bufsize=1,
        env=env,
    )

    stats = {"partial": 0, "final": 0, "status": [], "error": []}
    finals: list[str] = []
    stop = threading.Event()

    def reader() -> None:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                print("非 JSON 输出:", line)
                continue
            kind = msg.get("type")
            if kind == "partial":
                stats["partial"] += 1
            elif kind == "final":
                stats["final"] += 1
                finals.append(msg.get("text", ""))
            elif kind == "status":
                stats["status"].append(msg.get("state"))
            elif kind == "error":
                stats["error"].append(msg.get("message", ""))

    thread = threading.Thread(target=reader, daemon=True)
    thread.start()

    # 发送 start
    assert proc.stdin is not None
    proc.stdin.write(json.dumps({"type": "start"}) + "\n")
    proc.stdin.flush()

    time.sleep(4.0)

    proc.stdin.write(json.dumps({"type": "shutdown"}) + "\n")
    proc.stdin.flush()

    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        print("进程未在 5s 内退出")
    stop.set()

    err = proc.stderr.read() if proc.stderr else ""

    print("=" * 48)
    print("partial 条数 :", stats["partial"])
    print("final  条数 :", stats["final"])
    print("status 序列 :", " -> ".join(stats["status"]))
    print("错误        :", stats["error"] or "无")
    print("前两句 final:", finals[:2])
    print("退出码      :", proc.returncode)
    if err.strip():
        print("--- stderr ---")
        print(err.strip())

    ok = (
        stats["partial"] > 10
        and stats["final"] >= 1
        and "idle" in stats["status"]
        and "running" in stats["status"]
        and not stats["error"]
    )
    print("=" * 48)
    print("结果:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
