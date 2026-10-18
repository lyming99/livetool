# -*- coding: utf-8 -*-
"""唯一的麦克风目录：Media Foundation endpoint ID，不使用 PortAudio 编号。"""
from __future__ import annotations


def list_input_devices() -> list[dict]:
    from mf_capture import list_devices
    return [{**item, "api": "Windows Media Foundation"} for item in list_devices()]


def resolve_input_device(device=None) -> dict:
    from mf_capture import resolve_device
    return resolve_device(device)
