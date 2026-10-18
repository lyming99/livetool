# 唯一的 Windows Media Foundation 采集路径（0.1.2）

## 范围

所有音频输入均参考 wenzflow 的 `record 6.2.1` / `record_windows 1.0.7` 的 Media Foundation source-reader 管线。wenzflow 工程仅作只读参考，不参与构建或运行。

| 功能 | 采集输出 |
|---|---|
| 设备枚举 | MF capture endpoint，稳定 endpoint ID |
| 麦克风测试 | 16000 Hz / 单声道 / PCM16 原生流 |
| 测试录音 WAV | 44100 Hz / 单声道 / PCM16 |
| FunASR 实时字幕 | 16000 Hz / 单声道 / PCM16 原生流 |
| Whisper 实时字幕 | 16000 Hz / 单声道 / PCM16 原生流 |

录音参数对应 wenzflow 的录音笔记，字幕输入参数对应它的语音输入 `startStream`。不再存在可选的 PortAudio 采集，也不静默回退到其他采集 API。FunASR / Whisper 模型、推理参数和原模型缓存不变。

## 组件与协议

- `mf_capture.cpp`：Windows SDK 独立实现，`MFCreateDeviceSource` → `MFCreateSourceReaderFromMediaSource` → PCM16。
- 枚举通过 `MFEnumDeviceSources`，默认输入通过 `IMMDeviceEnumerator` 的 eCapture/eConsole 端点确定；捕获使用明确 endpoint ID。
- `GetCurrentMediaType` 验证位深、采样率、声道和块对齐，不按猜测格式解释样本。
- WAV 模式：小型 JSON 在 stdout，PCM 写入临时 WAV；确认成功后由 Python 原子发布文件。
- `--stream` 模式：**stdout 为二进制 PCM，stderr 为独立的 JSON 控制通道**（ready / record_level / complete / error）。不使用 Base64，不写无限增长的中间文件。
- `mf_stream.PcmInputStream` 处理任意管道边界、格式检查、有界缓冲、错误回传、超时和退出。PCM16 仅除以 32768 转为识别所需 float32；没有应用层调音或分块重采样。
- FunASR 将流按 9600 个样本（600ms）送模型；Whisper 每次读取 1600 个样本（100ms），保留其原有分段转写方式。
- stdin `stop\n` 停止；超时强制回收子进程。取消与 EOF 竞态不误报采集故障。
- 模型加载前后检查取消；后端在模型加载前即跟踪引擎，并用会话编号过滤旧任务回调。实际 PCM 就绪后才报告 running。

## 设备和配置迁移

`asr.audioDevice` 为 `null` 或稳定 endpoint ID，不再是 sounddevice 数字索引。旧数字索引在配置迁移时重置为系统默认并在设置页提示确认；已断开的 endpoint 不偷偷改成其他麦克风。

旧 `asr.recordBackend` 在读取、保存配置时删除。即使旧协议请求仍带 `portaudio`，后台也只有 MF 录音分支。打包排除 sounddevice / PortAudio / PyAudio。

首次覆盖当前 WAV 前保留 `test_recording_reference.wav`，已有参考不覆盖；“播放原录音”仅是旧文件的试听入口，不是旧采集入口。

## 构建与验证

```bat
npm run build:audio
npm run build:backend
npm run dist
```

构建机需要 Visual Studio C++ 工具和 Windows SDK；组件使用静态 MSVC 运行库，用户机器不需要编译器、Flutter、.NET 或 wenzflow。安装包中的 helper 位于后端 `_internal`，Python 通过 `sys._MEIPASS` 定位。

```bat
python tools/test_recording_regression.py
python tools/test_mf_capture.py
python tools/test_native_subtitles.py
node --test tools/test_recording_ui.js
python tools/test_packaged_recording.py
```

前三组和 JS 回归不使用真实麦克风。打包硬件测试隔离 APPDATA，不覆盖用户录音。

真人探针 `tools/probe_native_subtitles.py` 先预加载现有模型、保持麦克风关闭，只有明确 go 门控后才开始有限时长的测试；测试音频和事件仅留在项目 build 下，不打入安装包。

## 验证边界

本机 NX6 的 MF 对照录音已由用户试听确认音色正常。0.1.2 的真人测试还验证了真实 MF 16kHz 输入经原有 FunASR 模型产生 partial/final 字幕和正常释放采集。一次出字不代表所有内容的识别准确率已验证；Whisper 的采集与字幕回调经过自动化回归，不据此声称其所有真实模型都已试听或完整验证。

没有修改 Windows 全局音效、驱动音量或 wenzflow。原生 API 不等于 RAW/APO 绕过模式，不承诺关闭系统/硬件固定处理。
