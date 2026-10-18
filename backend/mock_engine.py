# -*- coding: utf-8 -*-
"""模拟识别引擎。

用途：在没接 FunASR、没下载模型之前，先把「Python -> Electron -> Canvas」
整条链路跑通。行为刻意模仿流式识别：逐字吐出 partial，句末给 final。
"""

from __future__ import annotations

import threading
import time

SENTENCES = [
    "欢迎来到直播间，今天我们来聊一聊实时字幕",
    "这个工具用的是流式语音识别，不是整段转写",
    "端到端的延迟大概在一秒左右",
    "中文的标点和数字都做过专门处理",
    "说错的地方会自动纠正，定稿之后就不会再变了",
    "长时间直播的时候，内存和 CPU 占用都很稳定",
]

# 每个字的间隔（秒），模拟流式出字速度
CHAR_INTERVAL = 0.045
# 句与句之间的停顿（秒）
SENTENCE_GAP = 0.45


class MockEngine:
    def __init__(self) -> None:
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self, on_partial, on_final, on_status) -> None:
        self._thread = threading.Thread(
            target=self._run,
            args=(on_partial, on_final),
            daemon=True,
            name="mock-asr",
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
            self._thread = None

    def _run(self, on_partial, on_final) -> None:
        index = 0
        while not self._stop.is_set():
            sentence = SENTENCES[index % len(SENTENCES)]
            index += 1

            # 逐字增长，模拟流式 partial
            for i in range(1, len(sentence) + 1):
                if self._stop.is_set():
                    return
                on_partial(sentence[:i])
                time.sleep(CHAR_INTERVAL)

            if self._stop.is_set():
                return
            on_final(sentence)
            on_partial("")
            time.sleep(SENTENCE_GAP)
