# livetool 框架与模块架构

## 本轮落地范围

应用已从根目录 `electron/`、`renderer/` 下的原生 JavaScript 脚本，迁移为 **Electron + TypeScript + electron-vite / Vite + React**。设置页使用 React；字幕窗继续独立使用 Canvas。Python 识别后端及 C++ 原生采集能力保留，不引入 localhost HTTP 服务，也不改用另一套采集库。

本轮没有额外引入状态库、UI 大组件库、微服务或插件系统。设置页通过可直接测试的 application model 与 `useSyncExternalStore` 连接 React，避免把原有大脚本搬成一个大组件。

Electron 大版本仍沿用项目原有的 38 系列；窗口内核升级应另做透明窗、穿透、置顶和多屏兼容验收，不与本次工程迁移混在一起。

## 目录与依赖方向

```text
src/
  main/
    index.ts                         应用装配、生命周期、托盘和快捷键
    ipc.ts                           白名单业务接口、来源与参数校验
    modules/
      subtitles.ts                   草稿/定稿、整句延时、预览、自动隐藏
      speech.ts                      识别/诊断互斥、启停、重载、错误与退出
    platform/
      windows.ts                     双窗口、显示器、穿透和置顶
    infrastructure/
      config-repository.ts           配置迁移、归一化、原子写入、密钥编码
      python-bridge.ts               子进程、JSONL 校验、退出与强制回收
      logging.ts                     日志轮换、脱敏
  preload/
    settings.ts                      设置窗可调用的明确业务方法
    overlay.ts                       字幕窗的最小能力集合
  renderer/
    settings.html
    settings/
      App.tsx                        页面装配与应用生命周期
      components/                    外观、音频、位置、行为、预览、引擎面板
      model/
        settings-model.ts            订阅、运行状态、动作编排
        config-writer.ts             乐观草稿、深合并、防抖、串行保存与重试
        diagnostics.ts               录制/识别状态及迟到结果保护
        playback.ts                  Blob/Audio 与 URL 生命周期
    overlay.html
    overlay/index.ts                 原 Canvas 排版与绘制，迁移为 TypeScript
  shared/
    defaults.json                    默认配置的唯一数据源
    config.ts                        配置类型、Schema、补丁及旧数据归一化
    contracts.ts                     双窗口 API 和后端事件协议
backend/                             原 Python 识别与音频封装
native/                              原 C++ Media Foundation / WASAPI 采集器
tests/                               Vitest：直接测试实际运行模块
tools/                               真实 Electron 回归、Python 回归和打包工具
out/                                 electron-vite 构建输出，不提交 Git
```

渲染层依赖方向：

```text
React 组件 → 设置页 model → 类型化 preload API → Electron IPC
```

主进程依赖方向：

```text
IPC / 托盘 / 快捷键 → 应用服务 → 窗口平台层 / 配置存储 / Python bridge
```

业务模块不依赖 React、BrowserWindow 或真实音频设备，因此可以注入假时钟、假进程和假 API 进行测试。

## 进程与数据通路

- 设置窗与字幕窗是独立渲染进程；不共享 JavaScript store。
- 主进程向 UI 发布运行状态，识别生命周期以 Python 确认事件为依据。
- Electron 与 Python 沿用 stdin/stdout JSON Lines，stderr 独立记录日志。
- Python 与原生采集器沿用二进制 PCM 管道及独立控制消息。
- 实时 PCM 不经过 React、不转成前端 JSON/base64，也不通过不断增长的文件传输。
- 只有用户请求播放诊断 WAV 时，才使用 IPC base64 → Blob → Audio。

## 生命周期与状态

`SpeechService` 统一管理识别、录音、识别录音及麦克风测试的互斥。重载采用：

```text
发送 stop → 等待 stopped 确认 → 发送 start → 接收 starting/running
```

不再以固定 500ms 延时猜测停止是否完成。同一时间的重载请求合并；等待停止最长 15 秒，失败明确返回错误并移除等待监听器。应用退出等待 sidecar 关闭，并保留超时强制结束子进程树的兜底。

字幕策略由 `SubtitleController` 单独负责：手动隐藏不会被新字幕强行顶开；自动超时隐藏才会被新内容恢复；预览期间暂停自动隐藏；停止或切换模式时取消待显示的旧整句。

设置页把已确认配置、尚未确认的草稿和串行保存任务分开。新编辑不会被旧配置回填覆盖；录音、切换引擎、检查环境等动作会先 flush 待保存配置。输入控件保留焦点内草稿，允许输入空值和中间数字，避免 120 被逐字输入时先夹成 5。

## IPC 与密钥边界

- 保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- preload 只暴露业务方法，不暴露 Electron、任意文件路径或 `bridge:command`。
- IPC 校验调用窗口与主 frame；字幕窗只能读脱敏配置、调整字幕位置、锁定字幕和打开设置。
- 配置补丁及重要参数使用 Zod 校验；新补丁拒绝未知字段，旧持久化配置走专用兼容归一化流程。
- 每个 preload 订阅返回精确的取消订阅函数。React 卸载清理订阅和轮询，字幕窗卸载清理订阅与计时器。
- API Key 在设置窗和识别进程中按需使用；不广播到字幕窗。
- 配置保存时使用 Electron `safeStorage` 编码密钥，磁盘保存 `apiKeyEncrypted`，普通 `apiKey` 留空。旧明文密钥在下一次成功保存配置时迁移。
- 加密服务不可用时，拒绝明文持久化；已有不可解密密文保留到用户明确重新输入或清空。
- `safeStorage` 保护本地持久化，不代表可抵御同一用户权限下的恶意程序。日志还会对已知密钥、Bearer token 和 apiKey 字段脱敏。

## 构建与打包

`package.json.main` 指向 `out/main/index.js`。主进程统一从 `out/` 找 preload 和两个 HTML；开发时使用 Vite URL，打包后使用 app.asar 内的本地构建文件。

每个 sandboxed preload 单独打包成一个文件，仅运行时依赖 Electron，不生成需要读取磁盘模块的共享 preload chunk。

Python 后端继续用 PyInstaller onedir；electron-builder 将其放入 `resources/backend`。原生采集器随后端装入，不写入 app.asar。配置、模型及诊断录音仍使用既有用户数据位置，不重置用户模型或录音。

## 测试与后续边界

- `npm run check`：类型检查、构建、Vitest、Python 假设备回归、真实 Electron 设置页与 WAV 播放、完整应用 mock 冒烟。
- `npm run test:dev`：验证 Vite 开发服务和实际双窗口应用。
- `tools/test_app_smoke.js --packaged=...`：验证实际打包 EXE、独立后端和重启持久化。
- 测试使用独立 userData、合成音频/假设备和 mock 识别，不自动打开真实麦克风、下载模型或调用付费 API。
- 原 `test_recording_ui.js`、`test_subtitle_mode.js` 保留为兼容入口，转而测试实际 TypeScript 模块，不保留两份运行实现。

本轮保留 Python 内部原目录，以及既有消息结构。未来可再整理 Python 包/依赖锁定、版本化 request-id 协议、能力声明与性能指标；这些不应在没有对应需求和测量时被扩张成微服务重写。
