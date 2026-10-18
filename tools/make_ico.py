# -*- coding: utf-8 -*-
"""生成 Windows 用的多尺寸 .ico（标准库实现，不需要 Pillow）。

ICO 从 Vista 起支持直接内嵌 PNG，所以这里把 PNG 塞进 ICO 容器即可。

用法: python tools/make_ico.py
"""

from __future__ import annotations

import math
import os
import struct
import zlib

SIZES = (16, 24, 32, 48, 64, 128, 256)


def make_png(size: int) -> bytes:
    """画一个圆角蓝底 + 两条白色字幕条的图标。"""
    rows = []
    radius = size / 2 - 1

    for y in range(size):
        row = bytearray([0])  # filter type 0
        for x in range(size):
            cx = x - size / 2 + 0.5
            cy = y - size / 2 + 0.5
            dist = math.hypot(cx, cy)

            if dist > radius:
                row += bytes((0, 0, 0, 0))
                continue

            # 边缘 1~2px 抗锯齿
            edge = max(1.0, size * 0.03)
            if dist > radius - edge:
                alpha = int(255 * (radius - dist) / edge)
            else:
                alpha = 255
            alpha = max(0, min(255, alpha))

            # 两条横杠代表字幕，按比例定位
            y1 = size * 0.30
            y2 = size * 0.55
            bar_h = max(2, size * 0.13)
            x_start = size * 0.24
            x_end = size * 0.76
            x_end2 = size * 0.62

            in_bar1 = y1 <= y <= y1 + bar_h and x_start <= x <= x_end
            in_bar2 = y2 <= y <= y2 + bar_h and x_start <= x <= x_end2

            if in_bar1 or in_bar2:
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
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    return png


def make_ico(path: str) -> None:
    images = [make_png(s) for s in SIZES]

    header = struct.pack("<HHH", 0, 1, len(images))
    entries = b""
    offset = 6 + 16 * len(images)

    for size, data in zip(SIZES, images):
        # 宽高为 0 表示 256
        dim = 0 if size >= 256 else size
        entries += struct.pack(
            "<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset
        )
        offset += len(data)

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(header + entries + b"".join(images))

    print(f"wrote {path} ({os.path.getsize(path)} bytes, {len(SIZES)} sizes)")


if __name__ == "__main__":
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    make_ico(os.path.join(root, "assets", "icon.ico"))
