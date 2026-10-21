# livetool

## 简介

一个开源的直播工具，目前只实现了实时字幕功能，后续会实现其它有意思的功能。

## 实现原理

使用funasr、whisper模型实现语音识别、断句，然后用electron框架显示识别内容字幕到屏幕上。

## 开发工具

模型：[deepseek v4.1 flash - 1017](https://platform.deepseek.com)

agent工具(个人产品，打个广告)：[wenzflow](https://wenzflow.com)

## 视频介绍

- [https://www.bilibili.com/video/BV1aBJz6EEtE](https://www.bilibili.com/video/BV1aBJz6EEtE)

## 功能列表

- [x] 实时字幕
- [x] 语音与字幕录制（真实音频分段 WAV + 标准 SRT / VTT 字幕，按日期时间归档）

## 系统支持

- [x] Windows
- [ ] macOS
- [ ] Linux

## 开发与架构

当前使用 **Electron + TypeScript + React + electron-vite / Vite**。设置页按功能组件化，字幕层保留独立 Canvas，Python 识别后端和 C++ 原生采集器保留。

代码入口位于 `src/main/index.ts`，不再直接编辑旧的根目录 `electron/`、`renderer/` 脚本。模块职责、进程通路、配置迁移和安全边界见 `docs/architecture.md`。

### 环境与启动

- Node.js **22.12 或更高版本**（本次本机验证使用 Node 24）。
- 源码运行使用本机 Python；真实识别仍需要原有 ASR/音频依赖与模型。
- Windows 原生采集组件可通过 `npm run build:audio` 构建，需本机 C++ 构建环境。

```bash
npm ci
npm run dev        # Vite 开发服务；使用 mock 识别，不自动打开麦克风
npm start          # 先构建，再启动真实识别模式；识别仍需手动点击开始
```

### 验证

```bash
npm run typecheck
npm test           # TypeScript 模块回归 + Python 假设备回归
npm run check      # 再包含真实 Electron 设置页、播放和完整应用 mock 冒烟
npm run test:dev    # 开发服务双窗口与 IPC 冒烟
```

这些自动化测试不需要说话、不加载真实识别模型，也不调用付费转写 API；使用独立临时用户数据，不覆盖现有配置或录音。

### 语音与字幕录制

在设置页「语音与字幕录制」里开启后，每次实时识别都会在指定文件夹下新建一个以开始时间命名的会话目录：

```
<录制目录>/20261022-143508/
  session.json                    会话清单：开始/结束时间、来源、片段与字幕索引（含绝对日期时间）
  audio/seg-0001-20261022-143508.wav   真实语音片段（PCM16 / 16kHz / 单声道）
  subtitles.srt                   标准字幕（相对会话开始的时间轴，毫秒精度）
```

- 音频按「片段时长」切分（默认 300 秒），文件名带该片段开始时间。
- 字幕可选 SRT 或 WebVTT；`session.json` 里每条字幕另带 `startedAt` / `endedAt` 绝对时间，便于按时间回查。
- 录制只在实时识别期间进行；录制目录为空时使用应用数据目录下的 `recordings`。
- 写文件失败只会降级为「只识别」，不会中断识别。
- 崩溃安全：WAV 头约每秒回填、会话清单约每 5 秒刷新，进程被强杀后已录片段仍可播放。
- 识别服务异常退出时会先保存当前会话，再自动退避重启（60 秒内最多 5 次）；用户主动停止不会触发重启。

### 打包

```bash
npm run build:backend   # 沿用原有后端及原生组件构建流程
npm run dist            # 构建 TypeScript/React，并生成 Windows NSIS 安装包
```

开发构建输出在 `out/`，常规安装包输出在 `dist/`。只更改桌面代码时可复用已构建后端；修改 Python/native 后应重新构建后端再打包。API Key 的旧明文配置会在下一次成功保存时迁移为本机系统加密密文。

本轮另存的安装包在 `dist/framework/livetool-0.1.8-setup.exe`，没有覆盖原 `dist/` 根下的既有安装包。源码/开发/打包 EXE 的验收范围与限制见 `docs/verification.md`。

对常规打包目录可额外执行完整应用冒烟（使用 mock，不启动麦克风）：

```bash
npm run pack
node tools/test_app_smoke.js --packaged=dist/win-unpacked/livetool.exe
```

## 界面截图

![Pasted image](assets/pasted-image-1792299695047121.png "Pasted image")

## 反馈交流

AI交流群(QQ)：1102616387

WenzFlow交流群(QQ)：482342865