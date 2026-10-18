'use strict'

const {
  app, BrowserWindow, Tray, Menu, globalShortcut,
  ipcMain, screen, nativeImage, powerSaveBlocker, protocol
} = require('electron')
const path = require('path')
const fs = require('fs')

const { loadConfig, saveConfig, DEFAULTS } = require('./config')
const { PythonBridge } = require('./python-bridge')

const ROOT = path.join(__dirname, '..')
const IS_DEV = process.argv.includes('--dev')
const USE_MOCK = process.argv.includes('--mock') || IS_DEV

// 少数显卡驱动下透明窗会出现黑底，可用环境变量兜底关闭硬件加速
if (process.env.LIVETOOL_NO_GPU === '1') {
  app.disableHardwareAcceleration()
}

let overlayWin = null
let settingsWin = null
let tray = null
let bridge = null

let clickThrough = true
let overlayVisible = true
let running = false
let recordingActive = false
let micTestActive = false
let recognizeActive = false
let lastRecordingPath = null
let engineStatus = { state: 'idle', detail: '' }
let subtitle = { final: '', partial: '' }
let previewText = ''
// 无新内容自动隐藏：计时器 + 「当前是超时自动隐藏的」标记（手动隐藏不应被新内容顶开）
let autoHideTimer = null
let autoHidden = false
// 整句定稿模式：final 先缓存，按 sentenceDelay 延迟后再推给字幕层
let sentenceTimer = null
let pendingSentence = ''
let psbId = null

/* ------------------------------------------------------------------ */
/* 显示器                                                              */
/* ------------------------------------------------------------------ */

/** Electron 的 display.id 在换接口、重启或改缩放后可能变，名称+分辨率可作为找回同一台屏幕的依据 */
function displayKey (d) {
  return `${d.label || ''}|${d.bounds.width}x${d.bounds.height}`
}

function listDisplays () {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d, index) => ({
    id: d.id,
    label: d.label || `显示器 ${index + 1}`,
    displayKey: displayKey(d),
    width: d.bounds.width,
    height: d.bounds.height,
    workWidth: d.workArea.width,
    workHeight: d.workArea.height,
    x: d.bounds.x,
    y: d.bounds.y,
    scaleFactor: d.scaleFactor,
    rotation: d.rotation,
    primary: d.id === primaryId
  }))
}

/** 按配置取目标显示器：先按 id，再按名称兜底，都对不上就用主屏 */
function targetDisplay () {
  const cfg = loadConfig()
  const all = screen.getAllDisplays()

  if (cfg.displayId != null) {
    const found = all.find(d => String(d.id) === String(cfg.displayId))
    if (found) return found
  }

  const label = cfg.displayLabel
  if (label) {
    const byName = all.find(d => (d.label || '') === label)
    if (byName) {
      // 名称对上了但 id 变了（换接口/重启/改缩放），把配置纠正到新的 id
      if (String(byName.id) !== String(cfg.displayId)) {
        saveConfig({ displayId: byName.id })
      }
      return byName
    }
  }

  // 配置的那台屏已经不在了：清掉失效记录，回退主屏
  if (cfg.displayId != null || cfg.displayLabel) {
    console.warn('[display] 配置的显示器不可用，回退主屏')
    saveConfig({ displayId: null, displayLabel: null })
  }
  return screen.getPrimaryDisplay()
}

/** 把字幕窗贴合到目标显示器的可用区域，并让渲染层按新尺寸重新排版 */
function fitOverlayToDisplay () {
  if (!overlayWin || overlayWin.isDestroyed()) return
  const { x, y, width, height } = targetDisplay().workArea
  const bounds = overlayWin.getBounds()
  if (bounds.x !== x || bounds.y !== y || bounds.width !== width || bounds.height !== height) {
    overlayWin.setBounds({ x, y, width, height })
  }
  // 缩放率变化时 Chromium 会换 devicePixelRatio，渲染层必须重算 canvas 尺寸
  overlayWin.webContents.send('overlay:metrics')
}

/** 重新读取显示器列表与分辨率/缩放率，供设置窗「刷新」和系统事件共用 */
function refreshDisplays () {
  const list = listDisplays()
  fitOverlayToDisplay()
  broadcast('displays:changed', list)
  return list
}

function onDisplayChange () {
  refreshDisplays()
  broadcast('config:changed', loadConfig())
}

/* ------------------------------------------------------------------ */
/* 字幕窗                                                              */
/* ------------------------------------------------------------------ */

function createOverlay () {
  const { x, y, width, height } = targetDisplay().workArea

  overlayWin = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    backgroundColor: '#00000000', // 必须全透明，否则 Windows 上会有底色
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,             // 有阴影会画出一圈灰边
    focusable: false,             // 不抢直播软件/游戏的焦点
    alwaysOnTop: true,
    show: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 窗口失焦时不要降频，否则字幕会卡
      spellcheck: false
    }
  })

  // 'screen-saver' 层级比普通置顶更高，能压住大多数全屏窗口化程序
  overlayWin.setAlwaysOnTop(true, 'screen-saver')
  overlayWin.setIgnoreMouseEvents(clickThrough, { forward: true })
  overlayWin.loadFile(path.join(ROOT, 'renderer', 'overlay.html'))

  overlayWin.once('ready-to-show', () => {
    overlayWin.showInactive() // 显示但不激活
  })

  overlayWin.webContents.on('did-finish-load', () => {
    overlayWin.webContents.send('config:changed', loadConfig())
    overlayWin.webContents.send('subtitle:state', subtitle)
    overlayWin.webContents.send('subtitle:preview', previewText)
    overlayWin.webContents.send('overlay:visible', overlayVisible)
    overlayWin.webContents.send('engine:status', engineStatus)
  })

  overlayWin.on('closed', () => { overlayWin = null })

  // 解锁后按 Esc 立即锁回。放在主进程的 before-input-event 里，
  // 比渲染层 keydown 更早拿到按键，也不受页面脚本影响。
  overlayWin.webContents.on('before-input-event', (event, input) => {
    if (clickThrough) return
    if (input.type !== 'keyDown') return
    if (input.key === 'Escape' || input.code === 'Escape') {
      event.preventDefault()
      setClickThrough(true)
    }
  })
}

function setClickThrough (value) {
  clickThrough = !!value
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setIgnoreMouseEvents(clickThrough, { forward: true })
    // 穿透时窗口不可聚焦；解锁后才能拖动和响应右键
    overlayWin.setFocusable(!clickThrough)
    if (!clickThrough) overlayWin.focus()
  }
  saveConfig({ clickThrough })
  broadcast('config:changed', loadConfig())
  refreshTray()
}

/** 当前是否有可显示的字幕内容（预览文字单独处理） */
function hasSubtitleContent () {
  return !!(subtitle.final || subtitle.partial)
}

function clearAutoHideTimer () {
  if (autoHideTimer) {
    clearTimeout(autoHideTimer)
    autoHideTimer = null
  }
}

/**
 * 按配置的耗时重新开始倒计时。
 * autoHideDelay 为 0 时不自动隐藏；没有内容或当前是预览状态时也不倒计时，
 * 否则刚手动点「显示字幕层」会马上又消失。
 */
function restartAutoHideCountdown () {
  clearAutoHideTimer()
  if (previewText) return
  const seconds = Number(loadConfig().autoHideDelay)
  if (!Number.isFinite(seconds) || seconds <= 0) return
  if (!overlayVisible || !hasSubtitleContent()) return

  autoHideTimer = setTimeout(() => {
    autoHideTimer = null
    if (!overlayVisible || !hasSubtitleContent()) return
    autoHidden = true
    setOverlayVisible(false, { auto: true })
    console.log('[overlay] 无新内容 ' + seconds + ' 秒，已自动隐藏字幕')
  }, seconds * 1000)
}

/** 收到新字幕内容时调用：超时隐藏过的先恢复显示，然后重新计时 */
function noteSubtitleActivity (hasText) {
  if (previewText) return
  // 没有内容（例如识别收尾送来的空串）不算活动，让已有倒计时继续走
  if (!hasText) return
  if (autoHidden && !overlayVisible) {
    autoHidden = false
    // setOverlayVisible 内部会重新开始倒计时
    setOverlayVisible(true)
    return
  }
  // 用户手动隐藏时不要自己弹出来
  if (!overlayVisible) return
  restartAutoHideCountdown()
}

/**
 * 字幕层显示/隐藏的唯一入口：窗口显隐、托盘文案、设置窗开关三者保持同步。
 * options.auto = true 表示这次是「无内容超时自动隐藏」，不是用户手动操作。
 */
function setOverlayVisible (value, options = {}) {
  const auto = !!options.auto
  overlayVisible = !!value

  if (auto) {
    // 自动隐藏：保留 autoHidden 标记，等有新内容再自动恢复
    autoHidden = true
    clearAutoHideTimer()
  } else {
    // 手动切换：退出自动隐藏态，并按当前内容重新计时
    autoHidden = false
    if (overlayVisible) restartAutoHideCountdown()
    else clearAutoHideTimer()
  }

  if (overlayWin && !overlayWin.isDestroyed()) {
    if (overlayVisible) {
      fitOverlayToDisplay()
      overlayWin.showInactive()
    } else {
      overlayWin.hide()
    }
  }
  broadcast('overlay:visible', overlayVisible)
  refreshTray()
  return overlayVisible
}

function toggleOverlayVisible () {
  return setOverlayVisible(!overlayVisible)
}

/** 预览测试文字：只影响字幕层显示，不写入配置、不影响识别结果 */
function setPreviewText (text) {
  previewText = typeof text === 'string' ? text : ''
  // 调样式时字幕层可能正好被隐藏了；有预览内容就先显示出来，否则用户看不到效果
  if (previewText && !overlayVisible) setOverlayVisible(true)
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('subtitle:preview', previewText)
  }
  // 预览期间不自动隐藏；退出预览后恢复按内容计时
  if (previewText) clearAutoHideTimer()
  else restartAutoHideCountdown()
  return previewText
}

/* ------------------------------------------------------------------ */
/* 设置窗                                                              */
/* ------------------------------------------------------------------ */

/** 让设置窗压在字幕层之上：字幕层是 screen-saver 层级的全屏置顶窗 */
function raiseSettingsWindow () {
  if (!settingsWin || settingsWin.isDestroyed()) return
  settingsWin.setAlwaysOnTop(true, 'screen-saver')
  settingsWin.moveTop()
}

function openSettings () {
  // 字幕层是铺满全屏的置顶窗：解锁（非穿透）状态下它会抢走鼠标事件，
  // 打开设置前先锁回穿透，否则用户会觉得设置界面「点不动」。
  if (clickThrough === false) setClickThrough(true)

  if (settingsWin && !settingsWin.isDestroyed()) {
    raiseSettingsWindow()
    settingsWin.show()
    settingsWin.focus()
    return
  }

  settingsWin = new BrowserWindow({
    width: 580,
    height: 760,
    minWidth: 500,
    minHeight: 600,
    title: '字幕设置',
    autoHideMenuBar: true,
    backgroundColor: '#111318',
    show: false, // 等页面渲染完再显示，避免启动时先闪一块白底
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  settingsWin.setMenuBarVisibility(false)
  settingsWin.loadFile(path.join(ROOT, 'renderer', 'settings.html'))

  settingsWin.once('ready-to-show', () => {
    if (!settingsWin || settingsWin.isDestroyed()) return
    raiseSettingsWindow()
    settingsWin.show()
    settingsWin.focus()
    console.log('[settings] 设置界面已显示', JSON.stringify({
      visible: settingsWin.isVisible(),
      focused: settingsWin.isFocused(),
      alwaysOnTop: settingsWin.isAlwaysOnTop()
    }))
  })

  // 有焦点时压过字幕层；切到别的应用后取消置顶，避免一直挡住别人
  settingsWin.on('focus', raiseSettingsWindow)
  settingsWin.on('blur', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setAlwaysOnTop(false)
  })

  settingsWin.webContents.on('did-finish-load', () => {
    if (!bridge) return
    bridge.send({ type: 'list_devices' })
    bridge.send({ type: 'check_env', engine: loadConfig().asr.engine, asr: loadConfig().asr })
  })
  settingsWin.on('closed', () => { settingsWin = null })
}

/* ------------------------------------------------------------------ */
/* Python sidecar                                                      */
/* ------------------------------------------------------------------ */

function startBridge () {
  if (bridge) return

  // 打包后 Python 后端是 extraResources 里的独立 exe，不在 asar 内
  const packaged = app.isPackaged
  const options = packaged
    ? {
        pythonPath: path.join(process.resourcesPath, 'backend', 'livetool-backend.exe'),
        script: null,
        // 打包后 app.asar 是文件，不能当工作目录，用可写的用户数据目录
        cwd: app.getPath('userData'),
        mock: false
      }
    : { mock: USE_MOCK }

  bridge = new PythonBridge(options)

  bridge.on('message', (msg) => {
    switch (msg.type) {
      case 'partial':
        // 整句定稿模式：草稿不下发，屏幕上不会出现半句
        if (loadConfig().subtitleMode === 'sentence') break
        subtitle.partial = msg.text || ''
        pushSubtitle()
        noteSubtitleActivity(!!(subtitle.final || subtitle.partial))
        break
      case 'final':
        if (loadConfig().subtitleMode === 'sentence') {
          scheduleSentence(msg.text || '')
          break
        }
        subtitle.final = msg.text || ''
        subtitle.partial = ''
        pushSubtitle()
        noteSubtitleActivity(!!(subtitle.final || subtitle.partial))
        break
      case 'status':
        engineStatus = { state: msg.state || 'unknown', detail: msg.detail || '' }
        // 启动预热后的 idle 可能晚于用户的 start 请求，不能把待启动状态清掉。
        // 运行中的 error 保留停止入口，等用户明确 stop 释放后端资源。
        if (engineStatus.state === 'stopped') running = false
        broadcast('engine:status', engineStatus)
        refreshTray()
        break
      case 'devices':
        broadcast('audio:devices', msg.inputs || [])
        // 扬声器（电脑声音）端点单独广播：设置页按当前采集模式渲染对应列表
        broadcast('audio:output-devices', msg.outputs || [])
        break
      case 'mic_test':
        micTestActive = false
        broadcast('mic:test', msg)
        break
      case 'record_result':
        recordingActive = false
        lastRecordingPath = msg.ok ? (msg.path || null) : null
        broadcast('record:result', msg)
        break
      case 'record_level':
        broadcast('record:level', msg)
        break
      case 'recognize_result':
        recognizeActive = false
        broadcast('recognize:result', msg)
        break
      case 'env':
        broadcast('env:state', msg)
        break
      case 'install':
        broadcast('install:progress', msg)
        break
      case 'error':
        running = false
        console.error('[python] 错误:', msg.message)
        engineStatus = { state: 'error', detail: msg.message || '' }
        broadcast('engine:status', engineStatus)
        refreshTray()
        break
      default:
        break
    }
  })

  bridge.on('log', (line) => console.log('[python]', line))
  bridge.on('stderr', (line) => console.error('[python:stderr]', line))
  bridge.on('error', (err) => {
    console.error('[python] 启动失败:', err.message)
    failDiagnostics('录音进程不可用：' + err.message)
    engineStatus = { state: 'error', detail: '无法启动 Python：' + err.message }
    broadcast('engine:status', engineStatus)
    refreshTray()
  })
  bridge.on('exit', ({ code }) => {
    console.log('[python] 进程退出，code =', code)
    bridge = null
    clearPendingSentence()
    failDiagnostics('录音进程已退出，请重新录制')
    if (running) {
      running = false
      engineStatus = { state: 'stopped', detail: '识别进程已退出' }
      broadcast('engine:status', engineStatus)
      refreshTray()
    }
  })

  bridge.start()

  // 起来后主动拉一次设备和依赖状态，设置窗打开时就能直接显示
  setTimeout(() => {
    if (!bridge) return
    bridge.send({ type: 'list_devices' })
    bridge.send({ type: 'check_env', engine: loadConfig().asr.engine, asr: loadConfig().asr })
  }, 400)

  if (USE_MOCK) {
    // 开发模式：自动开始，省得每次手动点
    setTimeout(() => {
      if (!running) toggleRunning()
    }, 800)
  }
}

function failDiagnostics (detail) {
  if (recordingActive) broadcast('record:result', { ok: false, detail })
  if (micTestActive) broadcast('mic:test', { ok: false, peak: 0, detail })
  if (recognizeActive) broadcast('recognize:result', { ok: false, detail })
  recordingActive = micTestActive = recognizeActive = false
}

function clearSentenceTimer () {
  if (sentenceTimer) {
    clearTimeout(sentenceTimer)
    sentenceTimer = null
  }
}

/** 丢弃还没显示的整句定稿（停止识别、切换显示方式、进程退出时调用） */
function clearPendingSentence () {
  clearSentenceTimer()
  pendingSentence = ''
}

/**
 * 整句定稿模式：这一句先缓存起来，按 sentenceDelay 延后再显示。
 * 延时里如果又来了一句，旧的直接丢弃，保证屏幕上出现的永远是完整句子。
 */
function scheduleSentence (text) {
  clearSentenceTimer()
  pendingSentence = String(text || '')
  const cfg = loadConfig()
  const raw = Number(cfg.sentenceDelay)
  const delay = Number.isFinite(raw) ? Math.min(10000, Math.max(0, Math.round(raw))) : 0

  const apply = () => {
    sentenceTimer = null
    subtitle.final = pendingSentence
    subtitle.partial = ''
    pushSubtitle()
    noteSubtitleActivity(!!subtitle.final)
  }

  if (delay <= 0) {
    apply()
    return
  }
  sentenceTimer = setTimeout(apply, delay)
}

function pushSubtitle () {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('subtitle:state', subtitle)
  }
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('subtitle:state', subtitle)
  }
}

function broadcast (channel, payload) {
  for (const win of [overlayWin, settingsWin]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function toggleRunning () {
  if (!bridge) startBridge()
  if (!bridge) return

  running = !running
  if (running) {
    // 开始识别时清掉预览测试文字，否则真实字幕会被测试文字顶掉
    if (previewText) setPreviewText('')
    // 上一轮停止时可能还留着没显示的整句，先丢掉
    clearPendingSentence()
    bridge.send({ type: 'start', asr: loadConfig().asr })
    if (psbId === null) {
      // 长时间直播时阻止系统休眠/关屏
      psbId = powerSaveBlocker.start('prevent-display-sleep')
    }
  } else {
    bridge.send({ type: 'stop' })
    // 停止后不要再来一句延迟显示的残留字幕
    clearPendingSentence()
    if (psbId !== null) {
      powerSaveBlocker.stop(psbId)
      psbId = null
    }
  }
  refreshTray()
}

/** 改了模型配置后让 Python 重新加载一次，不用重启整个应用 */
function reloadEngine () {
  if (!bridge) startBridge()
  if (!bridge) return false
  bridge.send({ type: 'stop' })
  const asr = loadConfig().asr
  setTimeout(() => {
    if (bridge) bridge.send({ type: 'start', asr })
  }, 500)
  running = true
  refreshTray()
  return true
}

/* ------------------------------------------------------------------ */
/* 托盘与热键                                                          */
/* ------------------------------------------------------------------ */

function trayIcon () {
  const iconPath = path.join(ROOT, 'assets', 'icon.png')
  if (fs.existsSync(iconPath)) return nativeImage.createFromPath(iconPath)
  return nativeImage.createEmpty()
}

function createTray () {
  tray = new Tray(trayIcon())
  tray.setToolTip('livetool 实时字幕')
  tray.on('double-click', openSettings)
  refreshTray()
}

function refreshTray () {
  if (!tray) return
  const statusText = {
    idle: '未启动',
    starting: '正在加载模型…',
    loading: '正在加载模型…',
    ready: '就绪',
    running: '识别中',
    stopped: '已停止',
    error: '出错'
  }[engineStatus.state] || engineStatus.state

  const menu = Menu.buildFromTemplate([
    { label: `状态：${statusText}`, enabled: false },
    { type: 'separator' },
    { label: running ? '停止识别' : '开始识别', click: toggleRunning },
    {
      label: clickThrough ? '解锁字幕（可拖动）  Ctrl+Alt+L' : '锁定字幕（鼠标穿透）  Ctrl+Alt+L',
      click: () => setClickThrough(!clickThrough)
    },
    { label: overlayVisible ? '隐藏字幕' : '显示字幕', click: toggleOverlayVisible },
    { type: 'separator' },
    { label: '设置…  Ctrl+Alt+S', click: openSettings },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
  tray.setContextMenu(menu)
}

function registerShortcuts () {
  const tryRegister = (accel, handler) => {
    if (!globalShortcut.register(accel, handler)) {
      console.warn('[hotkey] 注册失败（可能被其他软件占用）:', accel)
    }
  }
  tryRegister('Control+Alt+L', () => setClickThrough(!clickThrough))
  tryRegister('Control+Alt+S', openSettings)
  tryRegister('Control+Alt+H', toggleOverlayVisible)
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function referenceRecordingFile () {
  const base = app.isPackaged ? app.getPath('userData') : ROOT
  const reference = path.join(base, 'test_recording_reference.wav')
  if (fs.existsSync(reference)) return reference
  // At startup, the existing WAV is the old recording. Once a new one exists,
  // only the dedicated backup may be presented as an old reference.
  const old = path.join(base, 'test_recording.wav')
  return !lastRecordingPath && fs.existsSync(old) ? old : null
}

function registerIpc () {
  ipcMain.handle('config:get', () => loadConfig())

  ipcMain.handle('config:set', (_evt, patch) => {
    if (IS_DEV || process.env.LIVETOOL_CAPTURE) {
      console.log('[config:set]', JSON.stringify(patch))
    }
    const prevDisplayId = loadConfig().displayId
    const next = { ...(patch || {}) }

    // 切换显示器时同时记下名称，display.id 变化后还能找回同一台屏幕
    if (Object.prototype.hasOwnProperty.call(next, 'displayId')) {
      if (next.displayId == null) {
        next.displayLabel = null
      } else {
        const picked = screen.getAllDisplays().find(d => String(d.id) === String(next.displayId))
        next.displayLabel = picked ? (picked.label || null) : null
      }
    }

    const cfg = saveConfig(next)
    if (String(prevDisplayId) !== String(cfg.displayId)) fitOverlayToDisplay()

    // 改了自动隐藏耗时（或总开关）立即生效，不用等下一句字幕
    if (Object.prototype.hasOwnProperty.call(next, 'autoHideDelay')) {
      if (overlayVisible) restartAutoHideCountdown()
      else clearAutoHideTimer()
    }

    // 显示方式 / 定稿延时立即生效
    if (Object.prototype.hasOwnProperty.call(next, 'subtitleMode') ||
        Object.prototype.hasOwnProperty.call(next, 'sentenceDelay')) {
      if (cfg.subtitleMode === 'sentence') {
        // 切到整句模式：把屏幕上可能残留的半句草稿清掉
        if (subtitle.partial) {
          subtitle.partial = ''
          pushSubtitle()
        }
      } else {
        // 切回实时模式：丢掉还没显示的延时节
        clearPendingSentence()
      }
      // 还有一句在等延时，按新配置重新排期
      if (pendingSentence && cfg.subtitleMode === 'sentence') scheduleSentence(pendingSentence)
    }

    broadcast('config:changed', cfg)
    return cfg
  })

  ipcMain.handle('config:defaults', () => JSON.parse(JSON.stringify(DEFAULTS)))

  ipcMain.handle('displays:list', () => listDisplays())

  // 设置窗「刷新」：重新读取分辨率/缩放率，并让字幕窗重新贴合
  ipcMain.handle('displays:refresh', () => refreshDisplays())

  // 预览测试文字：只画在字幕层，不改配置、不影响识别
  ipcMain.handle('overlay:preview', (_evt, text) => setPreviewText(text))

  ipcMain.handle('devices:list', () => {
    if (!bridge) startBridge()
    if (bridge) bridge.send({ type: 'list_devices' })
    return true
  })

  ipcMain.handle('env:check', (_evt, engine) => {
    if (!bridge) startBridge()
    if (bridge) bridge.send({ type: 'check_env', engine, asr: loadConfig().asr })
    return true
  })

  ipcMain.handle('mic:test', () => {
    if (micTestActive || recordingActive || recognizeActive) return false
    if (!bridge) startBridge()
    micTestActive = !!(bridge && bridge.send({ type: 'mic_test', asr: loadConfig().asr }))
    return micTestActive
  })

  ipcMain.handle('test:record', (_evt, seconds) => {
    // 0 是明确的停止命令，不能再被 `Number(seconds) || 5` 转成重新启动。
    if (Number(seconds) === 0) {
      return !!(bridge && recordingActive && bridge.send({ type: 'stop_record' }))
    }
    if (recordingActive || micTestActive || recognizeActive) return false
    if (!bridge) startBridge()
    const duration = Number(seconds)
    recordingActive = !!(bridge && bridge.send({
      type: 'record_test',
      seconds: Number.isFinite(duration) && duration > 0 ? duration : 5,
      asr: loadConfig().asr
    }))
    if (recordingActive) lastRecordingPath = null
    return recordingActive
  })

  ipcMain.handle('test:recognize', () => {
    if (recognizeActive || recordingActive || micTestActive) return false
    if (!bridge) startBridge()
    recognizeActive = !!(bridge && bridge.send({ type: 'recognize_test', asr: loadConfig().asr }))
    return recognizeActive
  })

  ipcMain.handle('install:run', (_evt, engine) => {
    if (!bridge) startBridge()
    if (bridge) bridge.send({ type: 'install', engine, asr: loadConfig().asr })
    return true
  })

  ipcMain.handle('engine:toggle', () => {
    toggleRunning()
    return running
  })

  ipcMain.handle('engine:reload', () => reloadEngine())

  ipcMain.handle('overlay:set-click-through', (_evt, v) => {
    setClickThrough(v)
    return clickThrough
  })

  ipcMain.handle('overlay:set-visible', (_evt, v) => setOverlayVisible(v))

  ipcMain.handle('app:status', () => ({
    running,
    recording: recordingActive,
    micTesting: micTestActive,
    recognizing: recognizeActive,
    recordingPath: lastRecordingPath,
    referenceAvailable: !!referenceRecordingFile(),
    clickThrough,
    overlayVisible,
    engine: engineStatus,
    pythonPid: bridge ? bridge.pid : null,
    mock: USE_MOCK,
    packaged: app.isPackaged
  }))

  ipcMain.handle('bridge:command', (_evt, cmd) => {
    if (!bridge) startBridge()
    return bridge ? bridge.send(cmd || {}) : false
  })

  ipcMain.handle('recording:read', (_evt, kind) => {
    try {
      const p = kind === 'reference' ? referenceRecordingFile() : (lastRecordingPath || path.join(app.isPackaged ? app.getPath('userData') : ROOT, 'test_recording.wav'))
      if (!p || !fs.existsSync(p)) return null
      // 传 base64 而不是 Buffer：Buffer 经 IPC 结构化克隆后不一定是 Uint8Array，
      // 渲染层直接塞进 Blob 会失败，报 "no supported source was found"
      return fs.readFileSync(p).toString('base64')
    } catch (err) {
      console.error('[recording] 读取失败:', err.message)
      return null
    }
  })

  ipcMain.handle('app:open-settings', () => openSettings())

  ipcMain.handle('app:quit', () => app.quit())
}

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */

/**
 * 打包后的应用没有控制台，出问题只能靠日志文件。
 * 每次启动覆盖写，只保留本次运行的记录。
 */
function setupFileLogging () {
  try {
    const logPath = path.join(app.getPath('userData'), 'livetool.log')
    const stream = fs.createWriteStream(logPath, { flags: 'w' })
    const wrap = (original, prefix) => (...args) => {
      original(...args)
      try {
        stream.write(`${new Date().toISOString()} ${prefix}${args.map((a) => String(a)).join(' ')}\n`)
      } catch (_) { /* 写日志失败不影响主流程 */ }
    }
    console.log = wrap(console.log.bind(console), '')
    console.error = wrap(console.error.bind(console), 'ERROR ')
  } catch (_) { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', openSettings)

  app.whenReady().then(() => {
    setupFileLogging()

    // 让渲染层能直接播放本地 wav（livetool://media/?path=...）
    protocol.registerFileProtocol('livetool', (request, callback) => {
      try {
        const parsed = new URL(request.url)
        const filePath = parsed.searchParams.get('path')
        if (!filePath) {
          callback({ error: -2 })
          return
        }
        callback({ path: filePath })
      } catch (err) {
        console.error('[protocol] 解析失败:', err.message)
        callback({ error: -2 })
      }
    })

    createOverlay()
    createTray()
    registerIpc()
    registerShortcuts()

    // 显示器插拔、分辨率/缩放变化：重新贴合并通知设置窗刷新下拉框
    screen.on('display-metrics-changed', onDisplayChange)
    screen.on('display-added', onDisplayChange)
    screen.on('display-removed', onDisplayChange)

    clickThrough = loadConfig().clickThrough !== false
    setClickThrough(clickThrough)

    // 等窗口先渲染出来，再拉起 Python，避免启动瞬间白屏
    setTimeout(startBridge, 300)

    // 启动后直接显示设置界面（而不是只驻留托盘）：
    // 等字幕窗和托盘先就绪，避免设置窗先显示时背后一片空白。
    setTimeout(openSettings, 600)

    // 仅调试：把字幕窗和设置窗的渲染结果存成 PNG，用来验证界面
    if (process.env.LIVETOOL_CAPTURE) {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

      setTimeout(async () => {
        try {
          if (overlayWin && !overlayWin.isDestroyed()) {
            const overlayImg = await overlayWin.webContents.capturePage()
            fs.writeFileSync(path.join(ROOT, '.debug-overlay.png'), overlayImg.toPNG())
            console.log('[debug] 字幕窗截图完成')
          }

          // 验证水平锚点：临时挪到 72%，截图后复原
          if (overlayWin && !overlayWin.isDestroyed()) {
            saveConfig({ anchorX: 0.72 })
            overlayWin.webContents.send('config:changed', loadConfig())
            await sleep(500)
            const rightImg = await overlayWin.webContents.capturePage()
            fs.writeFileSync(path.join(ROOT, '.debug-overlay-right.png'), rightImg.toPNG())
            saveConfig({ anchorX: 0.5 })
            overlayWin.webContents.send('config:changed', loadConfig())
            console.log('[debug] 水平锚点截图完成')
          }

          // 验证预览测试文字：预览内容应能正常排版并渲染（与正式字幕同一套绘制逻辑）
          if (overlayWin && !overlayWin.isDestroyed()) {
            setPreviewText('预览测试文字：显示器切换与缩放刷新验收 abc 123')
            await sleep(500)
            const previewImg = await overlayWin.webContents.capturePage()
            fs.writeFileSync(path.join(ROOT, '.debug-overlay-preview.png'), previewImg.toPNG())
            console.log('[debug] 预览测试文字截图完成')
          }

          // 验证字幕显隐：隐藏后窗口应不可见，重新显示后应恢复可见
          console.log('[debug] 隐藏前 overlayVisible =', overlayVisible,
            'isVisible =', overlayWin && !overlayWin.isDestroyed() ? overlayWin.isVisible() : 'n/a')
          setOverlayVisible(false)
          await sleep(400)
          console.log('[debug] 隐藏后 overlayVisible =', overlayVisible,
            'isVisible =', overlayWin && !overlayWin.isDestroyed() ? overlayWin.isVisible() : 'n/a')
          setOverlayVisible(true)
          await sleep(400)
          console.log('[debug] 重新显示后 overlayVisible =', overlayVisible,
            'isVisible =', overlayWin && !overlayWin.isDestroyed() ? overlayWin.isVisible() : 'n/a')

          // 验证显示器识别：把主进程读到的分辨率/缩放率打印出来，便于和系统设置对照
          console.log('[debug] 显示器列表 =', JSON.stringify(listDisplays()))

          // 设置窗会被全屏置顶的字幕层盖住，截图前先临时隐藏字幕层
          if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide()
          await sleep(400)

          if (settingsWin && !settingsWin.isDestroyed()) {
            settingsWin.show()
            await sleep(200)
            const settingsImg = await settingsWin.webContents.capturePage()
            fs.writeFileSync(path.join(ROOT, '.debug-settings.png'), settingsImg.toPNG())

            // 滚到麦克风区域
            await settingsWin.webContents.executeJavaScript(
              'document.getElementById("audioDevice").scrollIntoView({ block: "center" })'
            )
            await sleep(250)
            const audioImg = await settingsWin.webContents.capturePage()
            fs.writeFileSync(path.join(ROOT, '.debug-settings-audio.png'), audioImg.toPNG())

            // 验证新增的「显示器信息」行：应显示当前字幕屏的分辨率/可用区/缩放率
            await settingsWin.webContents.executeJavaScript(
              'document.getElementById("displayInfo").scrollIntoView({ block: "center" })'
            )
            await sleep(250)
            const displayImg = await settingsWin.webContents.capturePage()
            fs.writeFileSync(path.join(ROOT, '.debug-settings-display.png'), displayImg.toPNG())

            // 验证新增的「自动隐藏」耗时控件
            await settingsWin.webContents.executeJavaScript(
              'document.getElementById("autoHideDelay").scrollIntoView({ block: "center" })'
            )
            await sleep(250)
            const autoHideImg = await settingsWin.webContents.capturePage()
            fs.writeFileSync(path.join(ROOT, '.debug-settings-autohide.png'), autoHideImg.toPNG())

            // 验证新增的「预览测试文字」区域与字幕显隐开关
            await settingsWin.webContents.executeJavaScript(
              'document.getElementById("previewText").scrollIntoView({ block: "center" })'
            )
            await sleep(250)
            const previewSectionImg = await settingsWin.webContents.capturePage()
            fs.writeFileSync(path.join(ROOT, '.debug-settings-preview.png'), previewSectionImg.toPNG())

            // 滚到底部，验证「识别引擎」区域
            await settingsWin.webContents.executeJavaScript(
              'document.querySelector(".content").scrollTop = 99999'
            )
            await sleep(300)
            const bottomImg = await settingsWin.webContents.capturePage()
            fs.writeFileSync(path.join(ROOT, '.debug-settings-bottom.png'), bottomImg.toPNG())

            // 切到 Whisper，验证专属字段和依赖状态
            await settingsWin.webContents.executeJavaScript(`
              const sel = document.getElementById('asrEngine');
              sel.value = 'whisper';
              sel.dispatchEvent(new Event('change'));
            `)
            await sleep(600)
            await settingsWin.webContents.executeJavaScript(
              'document.getElementById("asrEngine").scrollIntoView({ block: "start" })'
            )
            await sleep(300)
            const whisperImg = await settingsWin.webContents.capturePage()
            fs.writeFileSync(path.join(ROOT, '.debug-settings-whisper.png'), whisperImg.toPNG())

            await settingsWin.webContents.executeJavaScript(
              'document.querySelector(".content").scrollTop = 0'
            )
            console.log('[debug] 设置窗截图完成')
          }

          if (overlayWin && !overlayWin.isDestroyed()) overlayWin.showInactive()
        } catch (err) {
          console.error('[debug] 截图失败:', err)
        }
      }, 4500)
    }

    // 仅调试：验证「无新内容超时自动隐藏 / 有新内容自动恢复 / 手动隐藏不被顶开 / 0 关闭」
    if (process.env.LIVETOOL_TEST_AUTOHIDE) {
      setTimeout(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const state = () => `visible=${overlayVisible} autoHidden=${autoHidden} win=${overlayWin && !overlayWin.isDestroyed() ? overlayWin.isVisible() : 'n/a'}`

        // 必须先停掉 --dev 的 mock 引擎：它每 45ms 推一次 partial，
        // 每次都会被算成「有新内容」而重置倒计时，导致永远不会隐藏。
        if (bridge) {
          bridge.send({ type: 'stop' })
          await sleep(900)
        }
        subtitle.final = ''
        subtitle.partial = ''
        pushSubtitle()

        saveConfig({ autoHideDelay: 2 })
        setOverlayVisible(true)
        subtitle.final = '自动隐藏验证：第一段字幕'
        subtitle.partial = ''
        pushSubtitle()
        noteSubtitleActivity(true)
        console.log('[autohide] 有内容，2 秒后应自动隐藏 ->', state())

        await sleep(1200)
        console.log('[autohide] 1.2 秒后仍在显示 ->', state())
        await sleep(1400)
        console.log('[autohide] 2.6 秒后应已自动隐藏 ->', state())

        subtitle.final = '自动隐藏验证：新内容应让它重新出现'
        pushSubtitle()
        noteSubtitleActivity(true)
        await sleep(300)
        console.log('[autohide] 新内容后应自动恢复显示 ->', state())

        // 手动隐藏后不该被新内容顶开
        setOverlayVisible(false)
        subtitle.final = '自动隐藏验证：手动隐藏期间的新内容'
        pushSubtitle()
        noteSubtitleActivity(true)
        await sleep(600)
        console.log('[autohide] 手动隐藏后仍应隐藏 ->', state())

        // 0 = 关闭自动隐藏
        setOverlayVisible(true)
        saveConfig({ autoHideDelay: 0 })
        subtitle.final = '自动隐藏验证：0 表示不自动隐藏'
        pushSubtitle()
        noteSubtitleActivity(true)
        await sleep(2800)
        console.log('[autohide] 耗时 0 时 2.8 秒后仍应显示 ->', state())

        saveConfig({ autoHideDelay: 10 })
        console.log('[autohide] 验证结束，已恢复默认 10 秒')
      }, 3000)
    }

    // 仅调试：验证解锁后按 Esc 能锁回去
    if (process.env.LIVETOOL_TEST_ESC) {
      setTimeout(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        setClickThrough(false)
        await sleep(400)
        console.log('[test] 解锁后 clickThrough =', clickThrough, 'focused =', overlayWin.isFocused())
        overlayWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        await sleep(400)
        console.log('[test] 按 Esc 后 clickThrough =', clickThrough)
      }, 3000)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createOverlay()
    })
  })

  // 托盘常驻：关掉所有窗口也不退出
  app.on('window-all-closed', () => {})

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    if (psbId !== null) powerSaveBlocker.stop(psbId)
    if (bridge) bridge.stop()
  })
}
