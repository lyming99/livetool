# -*- coding: utf-8 -*-
"""音频端点目录。

- 麦克风：Media Foundation capture endpoint ID。
- 电脑声音：WASAPI 环回，使用扬声器（render）endpoint ID。
不使用 PortAudio / sounddevice 编号。
"""
from __future__ import annotations

# 采集模式 -> 中文标签
SOURCE_KINDS = {"input": "麦克风", "output": "电脑声音"}
# 兼容旧配置里显式的采集来源名
_KIND_ALIASES = {
    "mic": "input", "microphone": "input", "input": "input", "capture": "input",
    "system": "output", "loopback": "output", "output": "output", "speaker": "output",
}


def normalize_kind(kind=None) -> str:
    """把采集模式字段规整成 input / output；未知值回落麦克风。"""
    if isinstance(kind, str):
        return _KIND_ALIASES.get(kind.strip().lower(), "input")
    return "input"


def list_input_devices() -> list[dict]:
    from mf_capture import list_devices
    return [{**item, "api": "Windows Media Foundation"} for item in list_devices()]


def list_output_devices() -> list[dict]:
    from mf_capture import list_output_devices as _list_output_devices
    return [{**item, "api": "Windows WASAPI 环回"} for item in _list_output_devices()]


def list_devices(kind=None) -> list[dict]:
    kind = normalize_kind(kind)
    return list_output_devices() if kind == "output" else list_input_devices()


def resolve_input_device(device=None) -> dict:
    from mf_capture import resolve_device
    return resolve_device(device)


def resolve_device(device=None, kind=None) -> dict:
    from mf_capture import resolve_device as _resolve_device
    return _resolve_device(device, kind=normalize_kind(kind))


def capture_target(config: dict | None = None) -> dict:
    """把 asr 配置解析成采集目标：{kind, device, label}。

    config.captureSource 为 input（麦克风）或 output（电脑声音输出）；
    旧配置没有该字段时按麦克风处理，行为不变。
    设备 ID 分别取 audioDevice / audioOutputDevice。
    """
    cfg = config or {}
    kind = normalize_kind(cfg.get("captureSource"))
    device = cfg.get("audioOutputDevice") if kind == "output" else cfg.get("audioDevice")
    return {"kind": kind, "device": device, "label": SOURCE_KINDS[kind]}
