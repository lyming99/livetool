# 本轮框架优化验收

## 验收目标

将现有脚本式 Electron UI/主进程迁入 TypeScript、React 和 Vite 工程体系，拆分核心职责，保留 Python ASR、C++ 采集、字幕 Canvas 与现有用户操作。不是仅生成目录模板，也不把 mock 字幕当成真实麦克风识别效果。

## 已执行结果

| 验证 | 结果 | 范围 |
|---|---|---|
| `npm run typecheck` | 通过 | strict TypeScript；包括主进程、preload、双渲染入口与测试 |
| `npm run build` | 通过 | main、两个独立 sandboxed preload、React 设置页和 Canvas 字幕页 |
| `npm run test:unit` | **70 项通过** | 配置迁移/密文/原子写入、字幕策略、保存队列、诊断、播放、IPC 权限、订阅清理、启停/重载及进程失败重试 |
| `npm run test:backend` | **112 项通过** | 现有 Python 假设备、假接口与采集切换回归；统一入口修正 tools 导入路径 |
| 真实 Electron 设置页回归 | 通过 | 顶部实时字幕、设备两种目录、整句模式、API 预设/自定义、数字中间输入、先保存设备后录音、提前停止和识别结果 |
| 真实 Electron WAV 回放 | 通过 | 44.1kHz / 48kHz、真实 IPC/base64/Blob，播放速率 1、时长 0.25 秒 |
| `npm run test:dev` | 通过 | 明确断言使用 HTTP Vite 页面，而非遗留构建 HTML；实际双窗口与 Python mock 进程 |
| 构建目录完整应用冒烟 | 通过 | 真实主进程/IPC、双窗口、mock 实时字幕、确认式重载、显隐、密钥加密、重启恢复与子进程退出 |
| PyInstaller 后端重建 | 通过 | 采用当前工作区后端及原有 native helper，不修改 Python/native 源码 |
| 打包 EXE 冒烟 | 通过 | `dist/framework/win-unpacked/livetool.exe`，使用实际独立后端，不依赖源码 Python 路径 |
| app.asar 内设置页回归 | 通过 | 使用包内真实 preload 与 HTML，而非源码页面 |
| app.asar 内容核对 | **9 个输出文件逐字节一致** | `out/` 的全部 main/preload/renderer 输出，入口为 `out/main/index.js` |
| `git diff --check` | 通过 | 无补丁空白错误；既有换行提示不等于校验失败 |

测试使用独立 userData；完整应用测试同时隔离子进程 APPDATA。没有启动真实麦克风、下载识别模型、调用付费 API 或覆盖现有安装。WAV 播放使用合成短音频。

原 VM 测试的自然结束重录、重复停止、迟到状态、保存竞态、播放回收、模式切换等行为迁入实际 TypeScript 模块的测试，旧命令入口作为转发器保留，没有保留一套仅供测试的旧应用运行实现。

## 交付物

- 运行源码：`src/`
- 构建配置：`electron.vite.config.ts`、`tsconfig.json`、`vitest.config.ts`
- 开发命令与说明：`README.md`
- 架构、数据通路和安全边界：`docs/architecture.md`
- 已验证打包目录：`dist/framework/win-unpacked/`
- NSIS 安装包：`dist/framework/livetool-0.1.8-setup.exe`，构建成功，356,309,699 字节。
- 安装包 SHA-256：`167ced36bf6f696c110dd0ba71b7b9de2f187ffdf762b6b377ab7cedd3795c29`。
- 完整产物校验清单：`build/framework-verification.json`，包含安装包、主程序、app.asar、后端和原生采集器的字节数及 SHA-256。
- 安装包 Authenticode：`NotSigned`；没有执行安装覆盖现有程序。

采用独立 `dist/framework/` 输出，不覆盖原 `dist/` 根下的既有安装包。产品版本沿用 0.1.8，没有发布到版本后台，也没有自动安装覆盖用户程序。

## 环境与限制

本机使用 Node 24.13.0、Python 3.12.10；本轮保留 Electron 38 系列，未同时进行 Chromium/Electron 大版本兼容迁移。

本轮没有对真实说话音色、真实 ASR 准确率、长时间直播负载、多个实体显示器或所有显卡驱动进行实机验收。框架迁移不能等同于已证明识别更快、内存更低或音色改善。

构建出现了原 npm 镜像配置弃用提示、Zod 的 Rollup 注释处理提示，以及 PyInstaller 可选库/GPU 依赖提示。这些未阻止构建和上述回归，但也不能据此推断所有未测试模型路径均已验证。已验证主程序的 Authenticode 状态为 `NotSigned`。
