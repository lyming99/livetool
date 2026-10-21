import { app, Tray, Menu, globalShortcut, nativeImage, powerSaveBlocker, screen, safeStorage, dialog, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { ConfigRepository } from './infrastructure/config-repository'
import { PythonBridge } from './infrastructure/python-bridge'
import { setupLogging } from './infrastructure/logging'
import { WindowManager } from './platform/windows'
import { SubtitleController } from './modules/subtitles'
import { SpeechService } from './modules/speech'
import { registerIpc } from './ipc'
import { configPatchSchema, overlayConfig } from '../shared/config'
import type { AppStatus, BackendEvent } from '../shared/contracts'

const root = path.resolve(__dirname, '../..')
const outDirectory = path.resolve(__dirname, '..')
const mock = process.argv.includes('--mock') || (!app.isPackaged && !!process.env.ELECTRON_RENDERER_URL)
if (process.env.LIVETOOL_NO_GPU === '1') app.disableHardwareAcceleration()
// Isolated automation never touches the installed application's userData or instance lock.
if (process.env.LIVETOOL_TEST_USER_DATA) app.setPath('userData', process.env.LIVETOOL_TEST_USER_DATA)

if (!app.requestSingleInstanceLock()) app.quit()
else {
  let openSettings = (): void => {}
  app.on('second-instance', () => openSettings())
  app.on('window-all-closed', () => {})
  void app.whenReady().then(() => {
    const config = new ConfigRepository(path.join(app.getPath('userData'), 'config.json'), {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: value => safeStorage.encryptString(value).toString('base64'),
      decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64'))
    })
    // Hydrate before installing the log redactor: migration/read errors must not
    // recursively call config.load() through the redactor's secret getter.
    config.load()
    const closeLog = setupLogging(app.getPath('userData'), () => config.load().asr.apiKey)
    const dataDirectory = app.isPackaged ? app.getPath('userData') : root
    const speech = new SpeechService(() => new PythonBridge(app.isPackaged ? {
      executable: path.join(process.resourcesPath, 'backend', 'livetool-backend.exe'), cwd: app.getPath('userData'), mock
    } : {
      executable: process.env.LIVETOOL_PYTHON || 'python', script: path.join(root, 'backend', 'main.py'), cwd: root, mock
    }), () => config.load(), mock)
    let tray: Tray | null = null
    let blocker: number | null = null
    const windows = new WindowManager(config, {
      outDirectory, devServer: process.env.ELECTRON_RENDERER_URL,
      onOverlayReady: () => {
        windows.overlay?.webContents.send('config:changed', overlayConfig(config.load()))
        windows.overlay?.webContents.send('subtitle:state', subtitles.state)
        windows.overlay?.webContents.send('subtitle:preview', subtitles.previewText)
        windows.overlay?.webContents.send('overlay:visible', subtitles.visible)
        windows.setVisible(subtitles.visible)
      },
      onSettingsReady: () => { speech.listDevices(); speech.checkEnvironment(config.load().asr.engine) },
      onConfigChanged: () => broadcastConfig(), onEscape: () => setClickThrough(true)
    })
    const subtitles = new SubtitleController(() => config.load(), {
      subtitle: value => windows.send('subtitle:state', value),
      preview: text => windows.overlay?.webContents.send('subtitle:preview', text),
      visibility: value => { windows.setVisible(value); windows.send('overlay:visible', value); refreshTray() }
    })
    const broadcastConfig = (): void => {
      const value = config.load()
      windows.settings?.webContents.send('config:changed', value)
      windows.overlay?.webContents.send('config:changed', overlayConfig(value))
    }
    const setClickThrough = (value: boolean): boolean => {
      config.save({ clickThrough: value }); windows.setClickThrough(value); broadcastConfig(); refreshTray(); return value
    }
    openSettings = (): void => {
      if (!config.load().clickThrough) setClickThrough(true)
      windows.openSettings()
    }
    const referenceFile = (): string | null => {
      const reference = path.join(dataDirectory, 'test_recording_reference.wav')
      if (fs.existsSync(reference)) return reference
      const old = path.join(dataDirectory, 'test_recording.wav')
      return !speech.recordingPath && fs.existsSync(old) ? old : null
    }
    const status = (): AppStatus => ({
      running: speech.running, recording: speech.recording, micTesting: speech.micTesting, recognizing: speech.recognizing,
      recordingPath: speech.recordingPath, referenceAvailable: !!referenceFile(), clickThrough: config.load().clickThrough,
      overlayVisible: subtitles.visible, engine: speech.status, pythonPid: speech.pid, mock, packaged: app.isPackaged,
      session: speech.session
    })
    const refreshDisplays = (): ReturnType<WindowManager['displays']> => {
      const list = windows.displays(); windows.fitOverlay(); windows.send('displays:changed', list); broadcastConfig(); return list
    }
    const refreshTray = (): void => {
      if (!tray) return
      const state = { idle: '未启动', starting: '正在加载模型…', loading: '正在加载模型…', ready: '就绪', running: '识别中', restarting: '异常退出，自动重启中…', stopping: '正在停止…', stopped: '已停止', error: '出错' }[speech.status.state] || speech.status.state
      const perform = (action: () => Promise<unknown>): void => { void action().catch(error => console.error('[action]', error)) }
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: `状态：${state}`, enabled: false }, { type: 'separator' },
        { label: speech.running ? '停止识别' : '开始识别', enabled: !speech.recording && !speech.recognizing && !speech.micTesting, click: () => perform(() => speech.toggle()) },
        { label: config.load().clickThrough ? '解锁字幕（可拖动）  Ctrl+Alt+L' : '锁定字幕（鼠标穿透）  Ctrl+Alt+L', click: () => setClickThrough(!config.load().clickThrough) },
        { label: subtitles.visible ? '隐藏字幕' : '显示字幕', click: () => subtitles.setVisible(!subtitles.visible) },
        { type: 'separator' }, { label: '设置…  Ctrl+Alt+S', click: openSettings },
        { type: 'separator' }, { label: '退出', click: () => app.quit() }
      ]))
    }
    const removeIpc = registerIpc({
      windows, config, speech, subtitles, status, setClickThrough, openSettings, refreshDisplays,
      patchConfig: value => {
        const patch = configPatchSchema.parse(value)
        const previous = config.load()
        const next = config.save(patch)
        if (Object.hasOwn(patch, 'displayId')) {
          // Persist a display label so a changed numeric id can be recovered on the next launch.
          const display = next.displayId === null ? undefined : windows.displays().find(item => item.id === next.displayId)
          config.save({ displayLabel: display?.label ?? null })
        }
        if (previous.displayId !== next.displayId) windows.fitOverlay()
        if (Object.hasOwn(patch, 'clickThrough')) windows.setClickThrough(next.clickThrough)
        subtitles.configChanged(previous)
        if (patch.asr && ['captureSource', 'audioDevice', 'audioOutputDevice'].some(key => Object.hasOwn(patch.asr!, key))) speech.switchCapture()
        // 录制开关在识别运行中即时生效：否则本次识别会一直停在「等待录制会话就绪」。
        if (patch.asr && Object.hasOwn(patch.asr, 'recordEnabled')) speech.setRecord(next.asr.recordEnabled)
        broadcastConfig(); refreshTray(); return config.load()
      },
      recording: kind => {
        const file = kind === 'reference' ? referenceFile() : speech.recordingPath || path.join(dataDirectory, 'test_recording.wav')
        if (!file) return null
        const resolved = path.resolve(file)
        if (path.dirname(resolved) !== path.resolve(dataDirectory) || path.extname(resolved).toLowerCase() !== '.wav') throw new Error('录音路径不在应用数据目录中')
        return fs.existsSync(resolved) ? fs.readFileSync(resolved).toString('base64') : null
      },
      // 录制目录只接受用户在本机对话框里选定的路径，不接受渲染层任意字符串。
      chooseRecordingDir: async () => {
        const current = config.load().asr.recordDir.trim()
        const result = await dialog.showOpenDialog({
          title: '选择语音与字幕录制存放文件夹',
          defaultPath: current || path.join(dataDirectory, 'recordings'),
          properties: ['openDirectory', 'createDirectory']
        })
        if (result.canceled || !result.filePaths.length) return null
        return result.filePaths[0]
      },
      openRecordingDir: async () => {
        const configured = config.load().asr.recordDir.trim()
        const directory = configured || path.join(dataDirectory, 'recordings')
        try { fs.mkdirSync(directory, { recursive: true }) } catch (error) { console.error('[record-dir]', error) }
        const failure = await shell.openPath(directory)
        return !failure
      },
      quit: () => app.quit()
    })
    speech.on('subtitle', (event: Extract<BackendEvent, { type: 'partial' | 'final' }>) => {
      if (event.type === 'partial') subtitles.partial(event.text)
      else subtitles.final(event.text)
    })
    speech.on('reset-subtitles', () => { subtitles.cancelPending(); if (subtitles.previewText) subtitles.setPreview('') })
    speech.on('engine:status', value => {
      windows.send('engine:status', value)
      const preventSleep = speech.running && speech.status.state !== 'error'
      if (preventSleep && blocker === null) blocker = powerSaveBlocker.start('prevent-display-sleep')
      else if (!preventSleep && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null }
      refreshTray()
    })
    for (const channel of ['audio:devices', 'audio:output-devices', 'audio:capture-switch', 'mic:test', 'record:result', 'record:level', 'recognize:result', 'env:state', 'install:progress', 'session']) {
      speech.on(channel, value => { windows.settings?.webContents.send(channel, value); refreshTray() })
    }
    windows.createOverlay()
    const icon = path.join(root, 'assets', 'icon.png')
    tray = new Tray(fs.existsSync(icon) ? nativeImage.createFromPath(icon) : nativeImage.createEmpty())
    tray.setToolTip('livetool 实时字幕'); tray.on('double-click', openSettings); refreshTray()
    for (const [shortcut, action] of [
      ['Control+Alt+L', () => setClickThrough(!config.load().clickThrough)], ['Control+Alt+S', openSettings],
      ['Control+Alt+H', () => subtitles.setVisible(!subtitles.visible)]
    ] as const) if (!globalShortcut.register(shortcut, action)) console.error('[hotkey] 注册失败:', shortcut)
    screen.on('display-metrics-changed', refreshDisplays)
    screen.on('display-added', refreshDisplays)
    screen.on('display-removed', refreshDisplays)
    openSettings()
    setImmediate(() => speech.ensure())
    app.on('activate', () => { windows.createOverlay(); openSettings() })
    let shuttingDown = false
    app.on('before-quit', event => {
      if (shuttingDown) return
      shuttingDown = true
      event.preventDefault()
      void speech.dispose().finally(() => app.quit())
    })
    app.once('will-quit', () => {
      removeIpc(); globalShortcut.unregisterAll(); subtitles.dispose(); speech.dispose()
      if (blocker !== null) powerSaveBlocker.stop(blocker)
      tray?.destroy(); closeLog()
    })
  }).catch(error => { console.error('[startup]', error); app.exit(1) })
}
