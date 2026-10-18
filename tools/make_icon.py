# -*- coding: utf-8 -*-
"""生成托盘图标（无第三方依赖，用标准库写 PNG）。

用法: python tools/make_icon.py
"""

from __future__ import annotations

import math
import os
import struct
import zlib

SIZE = 64


def make_png(path: str) -> None:
    rows = []
    for y in range(SIZE):
        row = bytearray([0])  # filter type 0
        for x in range(SIZE):
            cx = x - SIZE / 2 + 0.5
            cy = y - SIZE / 2 + 0.5
            r = math.hypot(cx, cy)

            if r > 30:
                row += bytes((0, 0, 0, 0))
                continue

            # 边缘 2px 做抗锯齿
            alpha = 255 if r <= 28 else int(255 * (30 - r) / 2)
            alpha = max(0, min(255, alpha))

            # 两条白色横杠，代表字幕
            bar1 = 17 <= y <= 26 and 16 <= x <= 47
            bar2 = 33 <= y <= 42 and 16 <= x <= 38
            if bar1 or bar2:
                row += bytes((255, 255, 255, alpha))
            else:
                row += bytes((59, 130, 246, alpha))
        rows.append(bytes(row))

    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(png)
    print(f"wrote {path} ({len(png)} bytes)")


if __name__ == "__main__":
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    make_png(os.path.join(root, "assets", "icon.png"))
