# -*- coding: utf-8 -*-
"""验证 PyInstaller 打出来的 sidecar 能正常跑 stdio 协议。

用法: python tools/test_exe.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
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

    got = {"devices": None, "env": None, "status": []}

    def reader() -> None:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                print("非 JSON:", line)
                continue
            kind = msg.get("type")
            if kind == "devices":
                got["devices"] = msg.get("inputs")
            elif kind == "env":
                got["env"] = msg
            elif kind == "status":
                got["status"].append(msg.get("state"))

    threading.Thread(target=reader, daemon=True).start()

    assert proc.stdin is not None
    time.sleep(2.0)  # PyInstaller 首次启动会慢一点

    proc.stdin.write(json.dumps({"type": "list_devices"}) + "\n")
    proc.stdin.flush()
    time.sleep(1.0)

    proc.stdin.write(json.dumps({"type": "check_env", "engine": "whisper"}) + "\n")
    proc.stdin.flush()
    time.sleep(1.5)

    proc.stdin.write(json.dumps({"type": "shutdown"}) + "\n")
    proc.stdin.flush()
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        proc.kill()

    err = proc.stderr.read() if proc.stderr else ""

    print("=" * 56)
    print("启动状态序列 :", " -> ".join(got["status"]))
    devices = got["devices"] or []
    print("麦克风数量   :", len(devices))
    if devices:
        print("第一个设备   :", devices[0].get("name"), "|", devices[0].get("api"))
    env = got["env"] or {}
    print("环境检查     :", env.get("ready"), [d.get("package") for d in env.get("deps", []) if d.get("installed")])
    print("退出码       :", proc.returncode)
    if err.strip():
        print("--- stderr ---")
        print(err.strip()[-1500:])

    ok = (
        "idle" in got["status"]
        and len(devices) > 0
        and env.get("ready") is True
    )
    print("=" * 56)
    print("结果:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
