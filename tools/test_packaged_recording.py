# -*- coding: utf-8 -*-
"""打包版真实录音回归：会短暂使用麦克风，文件仅写隔离 APPDATA 并在结束后删除。

检查自然完成后连续三次录制、明确停止后重录、另一支麦克风，以及 WAV 采样率。
不会加载模型，不会修改已安装应用的数据或现有录音。
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time

import soundfile as sf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, "build", "livetool-backend", "livetool-backend.exe")


def main() -> int:
    messages = queue.Queue()
    stderr = []
    protocol_errors = []
    with tempfile.TemporaryDirectory(prefix="packaged-recording-", dir=os.path.join(ROOT, "build")) as temp:
        proc = subprocess.Popen([EXE], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1,
                                env={**os.environ, "APPDATA": temp, "PYTHONIOENCODING": "utf-8"})

        def read_stdout():
            for line in proc.stdout:
                try:
                    messages.put(json.loads(line))
                except json.JSONDecodeError:
                    protocol_errors.append(line.rstrip())

        def read_stderr():
            for line in proc.stderr:
                stderr.append(line.rstrip())

        threads = [threading.Thread(target=read_stdout, daemon=True),
                   threading.Thread(target=read_stderr, daemon=True)]
        for thread in threads:
            thread.start()

        def send(message):
            proc.stdin.write(json.dumps(message) + "\n")
            proc.stdin.flush()

        def wait_for(kind):
            deadline = time.monotonic() + 15
            while True:
                try:
                    result = messages.get(timeout=max(0.001, deadline - time.monotonic()))
                except queue.Empty as exc:
                    raise TimeoutError(f"打包版等候 {kind} 超时") from exc
                if result.get("type") == kind:
                    return result
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"打包版等候 {kind} 超时")

        def record(label, device=None, manual_stop=False):
            seconds = 5 if manual_stop else 0.8
            started = time.monotonic()
            send({"type": "record_test", "seconds": seconds, "asr": {"audioDevice": device}})
            if manual_stop:
                wait_for("record_level")
                time.sleep(0.25)
                send({"type": "stop_record"})
            result = wait_for("record_result")
            assert result.get("ok"), result
            assert result.get("backend") == "mediafoundation", result
            assert result.get("discontinuities", 0) == 0, result
            assert os.path.commonpath([temp, result["path"]]) == temp, result["path"]
            info = sf.info(result["path"])
            assert info.samplerate == result["sampleRate"], result
            assert abs(info.duration - result["duration"]) < 0.011, result
            assert result.get("overflows", 0) == 0, result
            if manual_stop:
                assert 0 < info.duration < 5, result
            else:
                assert abs(info.duration - seconds) < 0.001, result
            print(json.dumps({"case": label, "duration": info.duration,
                              "wallSeconds": round(time.monotonic() - started, 3),
                              "sampleRate": info.samplerate, "peak": result["peak"],
                              "rms": result.get("rms"), "clipped": result.get("clipped"),
                              "overflows": result.get("overflows"), "device": result.get("deviceName")},
                             ensure_ascii=False), flush=True)

        try:
            # 第一条指令就是录音；不先加载模型或做自检来规避冷启动问题。
            for i in range(3):
                record(f"default-repeat-{i + 1}")
            record("manual-stop", manual_stop=True)
            record("after-manual-stop")
            send({"type": "list_devices"})
            for device in wait_for("devices").get("inputs", []):
                if not device.get("default"):
                    record("other-microphone", device=device["id"])
            for i in range(2):
                send({"type": "mic_test", "asr": {"audioDevice": None}})
                mic = wait_for("mic_test")
                assert mic.get("backend") == "mediafoundation" and "16000Hz" in mic.get("detail", ""), mic
                print(json.dumps({"case": f"native-mic-test-{i + 1}", **mic}, ensure_ascii=False), flush=True)
            record("after-microphone-tests")
            send({"type": "shutdown"})
            proc.wait(timeout=5)
            for thread in threads:
                thread.join(timeout=1)
            assert proc.returncode == 0, proc.returncode
            assert not protocol_errors, protocol_errors
            print("PACKAGED HARDWARE RECORDING PASS; 隔离录音已删除，用户原录音未改动", flush=True)
            return 0
        except Exception as exc:
            print(f"PACKAGED HARDWARE RECORDING FAIL: {exc}", file=sys.stderr)
            for line in stderr[-20:]:
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
