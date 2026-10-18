# -*- coding: utf-8 -*-
"""Manual local probe: load the existing model first, then await an explicit gate.

The microphone stays CLOSED while awaiting go/cancel. All recordings and results
stay in the supplied project build directory; no installed user data is touched.
"""
import argparse
import json
import sys
import time
from pathlib import Path
import wave
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
# This probe must also work without an importable legacy capture package.
sys.modules["sounddevice"] = None
sys.modules["pyaudio"] = None
from asr_engine import FunAsrEngine
from mf_stream import PcmInputStream


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("folder")
    args = parser.parse_args()
    folder = Path(args.folder).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    engine = FunAsrEngine({"usePunc": False, "modelRevision": "v2.0.4"})
    engine._load_models()
    print(json.dumps({"state": "model_ready", "microphone": "closed", "folder": str(folder)}), flush=True)
    deadline = time.monotonic() + 180
    while not (folder / "go").exists():
        if (folder / "cancel").exists() or time.monotonic() >= deadline:
            print('CANCELLED; microphone was not opened', flush=True)
            return
        time.sleep(0.05)

    import mf_stream
    chunks = []
    events = []
    class ObservedPCM(PcmInputStream):
        def read(self, frames):
            audio = super().read(frames)
            if audio.size: chunks.append(audio.copy())
            return audio
    mf_stream.PcmInputStream = ObservedPCM
    engine._load_models = lambda: None  # use the exact already-loaded model, no second load
    def status(state, detail=""):
        events.append({"type": "status", "state": state, "detail": detail})
        print(json.dumps(events[-1], ensure_ascii=False), flush=True)
    def text(kind, value):
        events.append({"type": kind, "text": value})
        print(json.dumps(events[-1], ensure_ascii=False), flush=True)
    try:
        engine.start(lambda value:text("partial",value), lambda value:text("final",value), status)
        until = time.monotonic() + 12
        while time.monotonic() < until:
            if any(item.get("state") == "error" for item in events): break
            time.sleep(0.05)
    finally:
        engine.stop()
    audio = np.concatenate(chunks) if chunks else np.empty(0, dtype=np.float32)
    if audio.size:
        with wave.open(str(folder / "native-subtitle-input.wav"), "wb") as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
            wav.writeframes((audio * 32768).astype("<i2").tobytes())
    result = {"backend": "mediafoundation", "sampleRate": 16000, "frames": len(audio),
              "model": "existing FunASR ParaformerStreaming", "events": events,
              "has_text": any(item.get("text") for item in events),
              "capture_released": engine._capture is None,
              "error": any(item.get("state") == "error" for item in events)}
    (folder / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key:value for key,value in result.items() if key != "events"}, ensure_ascii=False), flush=True)
    if result["error"] or not result["has_text"] or not result["capture_released"]:
        raise SystemExit(1)


if __name__ == "__main__": main()
