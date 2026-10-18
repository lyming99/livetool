# -*- coding: utf-8 -*-
"""Windows 冷启动录音 stdio 回归，不加载模型、不打开麦克风、不写录音。

默认检查源码；--exe 检查 build 中的 PyInstaller 后端。
关键是打开 stdin 管道并保持不关闭：首次 NumPy/SciPy 加载若留在工作线程，
会与主线程等待读取下一条命令冲突。连续两次无效时长必须及时收到失败终态。
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", action="store_true")
    args = parser.parse_args()
    command = ([os.path.join(ROOT, "build", "livetool-backend", "livetool-backend.exe")]
               if args.exe else [sys.executable, "-X", "utf8", "-u", os.path.join(ROOT, "backend", "main.py")])
    proc = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, encoding="utf-8", text=True, bufsize=1,
                            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"})
    messages = queue.Queue()
    errors = []
    protocol_errors = []
    started = time.monotonic()

    def stdout_reader():
        for line in proc.stdout:
            try:
                messages.put(json.loads(line))
            except json.JSONDecodeError:
                protocol_errors.append(line.rstrip())

    def stderr_reader():
        for line in proc.stderr:
            errors.append(line.rstrip())

    threads = [threading.Thread(target=stdout_reader, daemon=True),
               threading.Thread(target=stderr_reader, daemon=True)]
    for thread in threads:
        thread.start()

    def send(message):
        proc.stdin.write(json.dumps(message) + "\n")
        proc.stdin.flush()

    def wait_for(kind):
        deadline = time.monotonic() + 15
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"等候 {kind} 超时")
            try:
                message = messages.get(timeout=remaining)
            except queue.Empty as exc:
                raise TimeoutError(f"等候 {kind} 超时，可能再次出现首次导入阻塞") from exc
            if message.get("type") == kind:
                return message

    try:
        # 不先枚举设备或跑模型自检，不关闭 stdin 来人为解开导入死锁。
        send({"type": "record_test", "seconds": -1})
        first = wait_for("record_result")
        assert first.get("ok") is False and "时长" in first.get("detail", ""), first
        first_seconds = time.monotonic() - started
        send({"type": "record_test", "seconds": -1})
        second = wait_for("record_result")
        assert second.get("ok") is False and "时长" in second.get("detail", ""), second
        send({"type": "shutdown"})
        proc.wait(timeout=5)
        for thread in threads:
            thread.join(timeout=1)
        assert not protocol_errors, protocol_errors
        assert proc.returncode == 0, proc.returncode
        print(f"COLD RECORDING STDIO PASS ({'packaged' if args.exe else 'source'}): "
              f"首次响应 {first_seconds:.2f}s，两次失败均及时复位，stdout 全为 JSON")
        for line in errors:
            print(line)
        return 0
    except Exception as exc:
        print(f"COLD RECORDING STDIO FAIL: {exc}", file=sys.stderr)
        for line in errors:
            print(line, file=sys.stderr)
        return 1
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            stream.close()


if __name__ == "__main__":
    raise SystemExit(main())
