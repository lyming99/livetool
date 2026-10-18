'use strict'
// 真实 Chromium + 实际设置页/preload 的界面回归。只模拟 IPC 数据，不打开麦克风或识别模型。
// electron tools/test_audio_settings_ui.js [--packaged-ui] [--capture=build/audio-settings.png]
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

const ROOT = path.join(__dirname, '..')
const packaged = process.argv.includes('--packaged-ui')
const APP_ROOT = packaged ? path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar') : ROOT
const captureArg = process.argv.find(arg => arg.startsWith('--capture='))
const topCaptureArg = process.argv.find(arg => arg.startsWith('--capture-top='))
const modeCaptureArg = process.argv.find(arg => arg.startsWith('--capture-mode='))
fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true })
const temp = fs.mkdtempSync(path.join(ROOT, 'build', 'audio-settings-ui-'))
app.setPath('userData', temp)
const { DEFAULTS } = require(path.join(APP_ROOT, 'electron', 'config.js'))
let cfg = JSON.parse(JSON.stringify(DEFAULTS))
let win
let recording = false
let recordingPath = null
const commands = []
const errors = []
const devices = [
  { id: 'ui-default', name: '默认麦克风', default: true },
  { id: 'ui-selected', name: '外接麦克风', default: false }
]
// 电脑声音输出（WASAPI 环回采集的扬声器端点）
const outputDevices = [
  { id: 'ui-speaker-default', name: '默认扬声器', default: true },
  { id: 'ui-speaker-headset', name: '耳机', default: false }
]
const send = (channel, payload) => win.webContents.send(channel, payload)

ipcMain.handle('config:get', () => cfg)
ipcMain.handle('config:defaults', () => DEFAULTS)
ipcMain.handle('config:set', (_event, patch) => {
  cfg = { ...cfg, ...patch, asr: { ...cfg.asr, ...(patch.asr || {}) } }
  send('config:changed', cfg)
  return cfg
})
ipcMain.handle('app:status', () => ({
  running: false, recording, micTesting: false, recognizing: false,
  recordingPath, clickThrough: true, overlayVisible: true,
  engine: { state: 'idle', detail: '' }, mock: true, packaged
}))
ipcMain.handle('displays:list', () => {
  const d = screen.getPrimaryDisplay()
  return [{ id: d.id, label: d.label || '主显示器', primary: true,
    width: d.bounds.width, height: d.bounds.height,
    workWidth: d.workArea.width, workHeight: d.workArea.height,
    x: d.bounds.x, y: d.bounds.y, scaleFactor: d.scaleFactor }]
})
ipcMain.handle('devices:list', () => {
  send('audio:devices', devices)
  send('audio:output-devices', outputDevices)
  return true
})
ipcMain.handle('env:check', () => {
  send('env:state', { ready: true, deps: [{ package: '界面验证', installed: true }] })
  return true
})
ipcMain.handle('test:record', (_event, seconds) => {
  commands.push({ seconds, device: cfg.asr.audioDevice })
  if (seconds !== 0) { recording = true; recordingPath = null }
  return true
})
ipcMain.handle('test:recognize', () => {
  commands.push({ type: 'recognize' })
  setTimeout(() => send('recognize:result', {
    ok: true, text: '界面回归测试', duration: 1, loadSeconds: 0, inferSeconds: 0.1
  }), 30)
  return true
})

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor (expression) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await win.webContents.executeJavaScript(expression)) return
    await pause(50)
  }
  throw new Error('界面等待超时: ' + expression)
}
const timeout = setTimeout(() => { console.error('AUDIO SETTINGS UI TIMEOUT'); app.exit(1) }, 25000)

app.whenReady().then(async () => {
  let code = 0
  try {
    win = new BrowserWindow({
      show: false, width: 720, height: 900,
      webPreferences: {
        preload: path.join(APP_ROOT, 'electron', 'preload-settings.js'),
        contextIsolation: true, nodeIntegration: false
      }
    })
    win.webContents.on('preload-error', (_event, _file, err) => errors.push(String(err)))
    await win.loadFile(path.join(APP_ROOT, 'renderer', 'settings.html'))
    await waitFor("document.getElementById('audioDevice').options.length === 3")

    const subtitleLayout = await win.webContents.executeJavaScript(`(() => {
      const content = document.querySelector('.content')
      const first = content.firstElementChild
      const preview = document.getElementById('preview')
      const r = preview.getBoundingClientRect()
      const viewport = content.getBoundingClientRect()
      return {
        firstTitle: first.querySelector('h2').textContent,
        firstContainsPreview: first.contains(preview),
        previewCount: document.querySelectorAll('#preview').length,
        visibleAtTop: content.scrollTop === 0 && r.top >= viewport.top && r.bottom <= viewport.bottom,
        placeholder: preview.textContent
      }
    })()`)
    assert.equal(subtitleLayout.firstTitle, '当前字幕')
    assert.equal(subtitleLayout.firstContainsPreview, true)
    assert.equal(subtitleLayout.previewCount, 1)
    assert.equal(subtitleLayout.visibleAtTop, true)
    assert.equal(subtitleLayout.placeholder, '（等待识别…）')

    // 通过真实 preload 订阅检查定稿、草稿和清空状态，不访问麦克风。
    send('subtitle:state', { final: '顶部字幕实时更新', partial: '正在识别…' })
    await waitFor("document.getElementById('preview').textContent === '顶部字幕实时更新正在识别…'")
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('#preview .draft').textContent"), '正在识别…')
    send('subtitle:state', { final: '', partial: '' })
    await waitFor("document.getElementById('preview').textContent === '（等待识别…）'")

    if (topCaptureArg) {
      const topPath = path.resolve(ROOT, topCaptureArg.slice('--capture-top='.length))
      fs.mkdirSync(path.dirname(topPath), { recursive: true })
      win.showInactive()
      await pause(250)
      const rect = await win.webContents.executeJavaScript(`(() => {
        const r = document.getElementById('preview').closest('section').getBoundingClientRect()
        return { x: 0, y: 0, width: window.innerWidth, height: Math.min(window.innerHeight, Math.ceil(r.bottom + 120)) }
      })()`)
      fs.writeFileSync(topPath, (await win.webContents.capturePage(rect)).toPNG())
      console.log('TOP SCREENSHOT: ' + topPath)
    }
    console.log('SUBTITLE TOP LAYOUT AND REALTIME UPDATE PASS')

    const controls = await win.webContents.executeJavaScript(`(() => {
      const section = document.getElementById('audioDevice').closest('section')
      return {
        buttons: [...section.querySelectorAll('button')].map(button => button.textContent.trim()),
        selectors: section.querySelectorAll('select').length,
        removed: ['btnTestMic', 'btnPlayReference', 'micTestResult', 'recordBackend'].filter(id => document.getElementById(id)),
        text: section.innerText
      }
    })()`)
    assert.deepEqual(controls.buttons, ['刷新', '录制 5 秒', '识别录音', '播放录音'])
    // 采集模式 + 设备两个下拉框
    assert.equal(controls.selectors, 2)
    assert.deepEqual(controls.removed, [])
    assert.doesNotMatch(controls.text, /参考 wenzflow|与 wenzflow 同类|播放原录音|测试麦克风|录音采集/)

    // 采集模式：默认麦克风，可切换到电脑声音输出并渲染扬声器列表
    const captureDefault = await win.webContents.executeJavaScript(`(() => {
      const source = document.getElementById('captureSource')
      const device = document.getElementById('audioDevice')
      return {
        value: source.value,
        options: [...source.options].map(option => option.value),
        label: document.getElementById('audioDeviceLabel').textContent,
        deviceValues: [...device.options].map(option => option.value),
        hint: document.getElementById('captureSourceHint').textContent
      }
    })()`)
    assert.deepEqual(captureDefault.options, ['input', 'output'])
    assert.equal(captureDefault.value, 'input')
    assert.equal(captureDefault.label, '麦克风')
    assert.match(captureDefault.hint, /麦克风/)

    // 切到电脑声音输出：标签、提示与设备列表都换成扬声器
    await win.webContents.executeJavaScript(`(() => {
      const source = document.getElementById('captureSource')
      source.value = 'output'
      source.dispatchEvent(new Event('change'))
    })()`)
    await waitFor("document.getElementById('audioDeviceLabel').textContent === '扬声器'")
    const captureOutput = await win.webContents.executeJavaScript(`(() => {
      const device = document.getElementById('audioDevice')
      return {
        source: cfg.asr.captureSource,
        label: document.getElementById('audioDeviceLabel').textContent,
        deviceValues: [...device.options].map(option => option.value),
        hint: document.getElementById('captureSourceHint').textContent
      }
    })()`)
    assert.equal(captureOutput.source, 'output')
    assert.equal(captureOutput.label, '扬声器')
    assert.deepEqual(captureOutput.deviceValues, ['default', 'ui-speaker-default', 'ui-speaker-headset'])
    assert.match(captureOutput.hint, /电脑声音输出/)

    // 切回麦克风，设备列表恢复
    await win.webContents.executeJavaScript(`(() => {
      const source = document.getElementById('captureSource')
      source.value = 'input'
      source.dispatchEvent(new Event('change'))
    })()`)
    await waitFor("document.getElementById('audioDeviceLabel').textContent === '麦克风'")
    assert.equal(await win.webContents.executeJavaScript('cfg.asr.captureSource'), 'input')

    // 显示方式：默认实时，此时草稿行开关可用、定稿延时说明不生效
    const modeDefaults = await win.webContents.executeJavaScript(`(() => {
      const mode = document.getElementById('subtitleMode')
      const delay = document.getElementById('sentenceDelay')
      return {
        modeValue: mode.value,
        options: [...mode.options].map(option => option.value),
        delayValue: delay.value,
        partialDisabled: document.getElementById('showPartial').disabled,
        delayDisabled: delay.disabled,
        modeHint: document.getElementById('subtitleModeHint').textContent,
        delayHint: document.getElementById('sentenceDelayHint').textContent
      }
    })()`)
    assert.deepEqual(modeDefaults.options, ['realtime', 'sentence'])
    assert.equal(modeDefaults.modeValue, 'realtime')
    assert.equal(modeDefaults.delayValue, '0')
    assert.equal(modeDefaults.partialDisabled, false)
    assert.equal(modeDefaults.delayDisabled, true)
    assert.match(modeDefaults.modeHint, /实时显示/)
    assert.match(modeDefaults.delayHint, /只在「整句定稿后显示」时生效/)

    // 切到整句定稿模式：草稿行开关禁用，延时输入启用，配置落盘
    await win.webContents.executeJavaScript(`(() => {
      const mode = document.getElementById('subtitleMode')
      mode.value = 'sentence'
      mode.dispatchEvent(new Event('change'))
      const delay = document.getElementById('sentenceDelay')
      delay.value = '300'
      delay.dispatchEvent(new Event('input'))
    })()`)
    await pause(250)
    const modeSentence = await win.webContents.executeJavaScript(`(() => {
      const delay = document.getElementById('sentenceDelay')
      return {
        partialDisabled: document.getElementById('showPartial').disabled,
        delayDisabled: delay.disabled,
        delayValue: delay.value,
        modeHint: document.getElementById('subtitleModeHint').textContent,
        delayHint: document.getElementById('sentenceDelayHint').textContent
      }
    })()`)
    assert.equal(modeSentence.partialDisabled, true)
    assert.equal(modeSentence.delayDisabled, false)
    assert.equal(modeSentence.delayValue, '300')
    assert.match(modeSentence.modeHint, /整句定稿后才出现/)
    assert.match(modeSentence.delayHint, /300 毫秒/)
    assert.equal(cfg.subtitleMode, 'sentence')
    assert.equal(cfg.sentenceDelay, 300)

    if (modeCaptureArg) {
      const modePath = path.resolve(ROOT, modeCaptureArg.slice('--capture-mode='.length))
      fs.mkdirSync(path.dirname(modePath), { recursive: true })
      win.showInactive()
      await win.webContents.executeJavaScript("document.getElementById('subtitleMode').scrollIntoView({block: 'center'})")
      await pause(250)
      const rect = await win.webContents.executeJavaScript(`(() => {
        const section = document.getElementById('subtitleMode').closest('section')
        const r = section.getBoundingClientRect()
        return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }
      })()`)
      fs.writeFileSync(modePath, (await win.webContents.capturePage(rect)).toPNG())
      console.log('MODE SCREENSHOT: ' + modePath)
    }
    console.log('SUBTITLE MODE CONTROLS PASS')

    // 识别引擎：接口（云端 API）区块的字段、联动提示与配置落盘
    const engineOptions = await win.webContents.executeJavaScript(
      "[...document.getElementById('asrEngine').options].map(o => o.value)")
    assert.deepEqual(engineOptions, ['funasr', 'whisper', 'api'])

    await win.webContents.executeJavaScript(`(() => {
      const engine = document.getElementById('asrEngine')
      engine.value = 'api'
      engine.dispatchEvent(new Event('change'))
      document.getElementById('apiBaseUrl').value = 'https://api.test/v1'
      document.getElementById('apiBaseUrl').dispatchEvent(new Event('change'))
      document.getElementById('apiModel').value = 'whisper-1'
      document.getElementById('apiModel').dispatchEvent(new Event('change'))
      document.getElementById('apiTimeout').value = '45'
      document.getElementById('apiTimeout').dispatchEvent(new Event('change'))
    })()`)
    await pause(300)

    const apiBlock = await win.webContents.executeJavaScript(`(() => {
      const block = document.querySelector('.engine-block[data-engine="api"]')
      const style = getComputedStyle(block)
      return {
        visible: style.display !== 'none',
        activeBlocks: [...document.querySelectorAll('.engine-block.active')]
          .map(node => node.dataset.engine),
        hasFields: ['apiBaseUrl', 'apiKey', 'apiModel', 'apiLanguage', 'apiPrompt', 'apiTimeout']
          .every(id => !!document.getElementById(id)),
        languageOptions: [...document.getElementById('apiLanguage').options].map(o => o.value),
        installHint: document.getElementById('installHint').textContent,
        installButton: document.getElementById('btnInstall').textContent.trim(),
        engine: cfg.asr.engine,
        baseUrl: cfg.asr.apiBaseUrl,
        timeout: cfg.asr.apiTimeout
      }
    })()`)
    assert.equal(apiBlock.visible, true)
    assert.deepEqual(apiBlock.activeBlocks, ['api'])
    assert.equal(apiBlock.hasFields, true)
    assert.deepEqual(apiBlock.languageOptions, ['zh', 'en', 'auto'])
    assert.match(apiBlock.installHint, /接口模式不用下载模型/)
    assert.equal(apiBlock.installButton, '校验接口配置')
    assert.equal(apiBlock.engine, 'api')
    assert.equal(apiBlock.baseUrl, 'https://api.test/v1')
    assert.equal(apiBlock.timeout, 45)
    console.log('API ENGINE BLOCK PASS')

    // 切回本地引擎：区块收起，按钮文案恢复
    await win.webContents.executeJavaScript(`(() => {
      const engine = document.getElementById('asrEngine')
      engine.value = 'funasr'
      engine.dispatchEvent(new Event('change'))
    })()`)
    await pause(200)
    const backToLocal = await win.webContents.executeJavaScript(`(() => ({
      engine: cfg.asr.engine,
      activeBlocks: [...document.querySelectorAll('.engine-block.active')].map(node => node.dataset.engine),
      installButton: document.getElementById('btnInstall').textContent.trim()
    }))()`)
    assert.equal(backToLocal.engine, 'funasr')
    assert.deepEqual(backToLocal.activeBlocks, ['funasr'])
    assert.equal(backToLocal.installButton, '一键安装 / 下载模型')

    await win.webContents.executeJavaScript(`(() => {
      const select = document.getElementById('audioDevice')
      select.value = 'ui-selected'
      select.dispatchEvent(new Event('change'))
      document.getElementById('btnRecordTest').click()
    })()`)
    await waitFor("document.getElementById('btnRecordTest').textContent === '停止录制'")
    assert.deepEqual(commands[0], { seconds: 5, device: 'ui-selected' })
    await win.webContents.executeJavaScript("document.getElementById('btnRecordTest').click()")
    await waitFor("document.getElementById('btnRecordTest').textContent === '正在停止…'")
    assert.deepEqual(commands[1], { seconds: 0, device: 'ui-selected' })
    recording = false
    recordingPath = path.join(temp, 'synthetic.wav')
    send('record:result', { ok: true, path: recordingPath, duration: 1,
      sampleRate: 16000, channels: 1, rms: 0.1, peak: 0.2 })
    await waitFor("!document.getElementById('btnRecognizeTest').disabled && !document.getElementById('btnPlayRecording').disabled")
    const hint = await win.webContents.executeJavaScript("document.getElementById('recordResult').innerText")
    assert.doesNotMatch(hint, /播放原录音/)
    await win.webContents.executeJavaScript("document.getElementById('btnRecognizeTest').click()")
    await waitFor("document.getElementById('recordResult').innerText.includes('界面回归测试')")
    assert.equal(commands[2].type, 'recognize')
    assert.equal(errors.length, 0, errors.join('\n'))

    if (captureArg) {
      const capturePath = path.resolve(ROOT, captureArg.slice('--capture='.length))
      fs.mkdirSync(path.dirname(capturePath), { recursive: true })
      // 显示但不抢焦点，让 Chromium 提交最新绘制帧，避免隐藏窗口截图停留在初始画面。
      win.showInactive()
      await win.webContents.executeJavaScript("document.getElementById('audioDevice').scrollIntoView({block: 'center'})")
      await pause(250)
      const rect = await win.webContents.executeJavaScript(`(() => {
        const r = document.getElementById('audioDevice').closest('section').getBoundingClientRect()
        return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }
      })()`)
      fs.writeFileSync(capturePath, (await win.webContents.capturePage(rect)).toPNG())
      console.log('SCREENSHOT: ' + capturePath)
    }
    console.log(JSON.stringify({ packaged, buttons: controls.buttons, selectors: controls.selectors, commands }))
    console.log('AUDIO SETTINGS UI PASS (synthetic IPC, no microphone access)')
  } catch (err) {
    code = 1
    console.error(err.stack || err)
  } finally {
    clearTimeout(timeout)
    if (win && !win.isDestroyed()) win.destroy()
    try { fs.rmSync(temp, { recursive: true, force: true }) } catch (_) { /* Chromium 可能尚未释放缓存 */ }
    app.exit(code)
  }
})
