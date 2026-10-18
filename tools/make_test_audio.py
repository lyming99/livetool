# -*- coding: utf-8 -*-
"""生成一段中文测试音频（16k 单声道 wav），用于验证流式识别。"""

from __future__ import annotations

import asyncio
import os
import sys

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass

TEXT = "大家好，欢迎来到直播间。今天我们来测试一下实时字幕的效果。"
OUT_WAV = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "test_audio.wav")
OUT_MP3 = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "test_audio.mp3")


def synth() -> None:
    import edge_tts

    async def run() -> None:
        communicate = edge_tts.Communicate(TEXT, "zh-CN-XiaoxiaoNeural")
        await communicate.save(OUT_MP3)

    asyncio.run(run())
    print("mp3 ok:", OUT_MP3)


def to_wav() -> None:
    import av
    import numpy as np
    import soundfile as sf

    container = av.open(OUT_MP3)
    stream = container.streams.audio[0]
    resampler = av.AudioResampler(format="flt", layout="mono", rate=16000)

    chunks = []
    for frame in container.decode(stream):
        for resampled in resampler.resample(frame):
            chunks.append(resampled.to_ndarray().flatten())
    # flush
    for resampled in resampler.resample(None):
        chunks.append(resampled.to_ndarray().flatten())

    audio = np.concatenate(chunks).astype(np.float32)
    sf.write(OUT_WAV, audio, 16000, subtype="PCM_16")
    print(f"wav ok: {OUT_WAV}  时长 {len(audio)/16000:.2f}s")


if __name__ == "__main__":
    synth()
    to_wav()
