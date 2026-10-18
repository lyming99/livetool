'use strict'
// 只执行 VM 中的渲染层/主进程协议逻辑，不启动 Electron、不访问麦克风。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const ROOT = path.join(__dirname, '..')

function deferred () {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

function rendererFixture () {
  const html = fs.readFileSync(path.join(ROOT, 'renderer/settings.html'), 'utf8')
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]))
  const elements = new Map()
  function element (id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: false, disabled: false, textContent: '', innerHTML: '',
      style: {}, listeners: {}, children: [], type: 'text',
      classList: { add () {}, remove () {}, toggle () {} },
      addEventListener (name, fn) { this.listeners[name] = fn },
      appendChild (child) { this.children.push(child) }
    })
    return elements.get(id)
  }
  const events = {}
  const commands = []
  const audios = []
  const revoked = []
  const api = {
    testRecord: async seconds => { commands.push(seconds); return true },
    testMic: async () => true,
    testRecognize: async () => true,
    setConfig: async () => ({ asr: {} }),
    readRecording: async () => Buffer.from('RIFF fake wav data').toString('base64')
  }
  for (const name of ['Subtitle', 'Status', 'DisplaysChanged', 'OverlayVisible', 'AudioDevices',
    'AudioOutputDevices', 'MicTest', 'RecordResult', 'RecordLevel', 'RecognizeResult', 'EnvState',
    'InstallProgress', 'Config']) {
    api['on' + name] = cb => { events[name] = cb }
  }
  class Audio {
    constructor (url) { this.url = url; this.playbackRate = 1; this.paused = false; this.listeners = {}; audios.push(this) }
    play () { return Promise.resolve() }
    pause () { this.paused = true }
    removeAttribute () {}
    load () {}
    addEventListener (name, cb) { this.listeners[name] = cb }
  }
  let urlId = 0
  const context = vm.createContext({
    document: { getElementById: id => ids.has(id) ? element(id) : null, querySelectorAll: () => [], createElement: () => element('new-' + Math.random()) },
    window: { settingsAPI: api, addEventListener () {} },
    console, setTimeout: () => 1, clearTimeout () {},
    URL: { createObjectURL: () => 'blob:' + (++urlId), revokeObjectURL: url => revoked.push(url) },
    Audio, Blob, Uint8Array, atob
  })
  const source = fs.readFileSync(path.join(ROOT, 'renderer/settings.js'), 'utf8')
  vm.runInContext(source.slice(0, source.indexOf('/* ---------------- 启动')), context)
  vm.runInContext('cfg = { asr: {} }; diagnosticsHydrated = true; bindAll(); syncAudioControls()', context)
  const click = id => element(id).listeners.click()
  const result = (extra = {}) => events.RecordResult({ ok: true, path: 'record.wav', peak: 0.2, rms: 0.1,
    duration: 5, sampleRate: 44100, clipped: 0, ...extra })
  return { context, api, commands, events, audios, revoked, element, click, result }
}

test('界面：自然结束后连续录制三次', async () => {
  const f = rendererFixture()
  for (let i = 0; i < 3; i++) {
    await f.click('btnRecordTest')
    assert.equal(f.element('btnRecordTest').textContent, '停止录制')
    f.result()
    assert.equal(f.element('btnRecordTest').textContent, '录制 5 秒')
    assert.equal(f.element('btnRecordTest').disabled, false)
  }
  assert.deepEqual(f.commands, [5, 5, 5])
})

test('界面：实际采集开始前只提示准备，不提前让用户说话', async () => {
  const f = rendererFixture()
  await f.click('btnRecordTest')
  assert.match(f.element('recordResult').textContent, /正在准备录音/)
  f.events.RecordLevel({ level: 0, elapsed: 0.1, duration: 5 })
  assert.match(f.element('recordResult').textContent, /正在录制，请对着麦克风说话/)
})

test('界面：提前停止只发一次，收到终态前不重入', async () => {
  const f = rendererFixture()
  await f.click('btnRecordTest')
  await f.click('btnRecordTest')
  await f.click('btnRecordTest')
  assert.deepEqual(f.commands, [5, 0])
  assert.equal(f.element('btnRecordTest').disabled, true)
  f.result({ duration: 1 })
  await f.click('btnRecordTest')
  assert.deepEqual(f.commands, [5, 0, 5])
})

test('界面：IPC 返回 false 或拒绝时，恢复按钮以允许重试', async () => {
  const f = rendererFixture()
  f.api.testRecord = async () => false
  await f.click('btnRecordTest')
  assert.match(f.element('recordResult').textContent, /录制失败/)
  assert.equal(f.element('btnRecordTest').disabled, false)
  f.api.testRecord = async () => { throw new Error('IPC failure') }
  await f.click('btnRecordTest')
  assert.match(f.element('recordResult').textContent, /IPC failure/)
  assert.equal(f.element('btnRecordTest').textContent, '录制 5 秒')
  f.api.testRecord = async s => { f.commands.push(s); return true }
  await f.click('btnRecordTest')
  assert.deepEqual(f.commands, [5])
})

test('界面：后端失败终态复位，并禁止播放失败录音', async () => {
  const f = rendererFixture()
  await f.click('btnRecordTest')
  f.result({ ok: false, detail: 'device busy' })
  assert.equal(f.element('btnRecordTest').disabled, false)
  assert.equal(f.element('btnPlayRecording').disabled, true)
  assert.equal(f.element('btnRecognizeTest').disabled, true)
  await f.click('btnRecordTest')
  assert.deepEqual(f.commands, [5, 5])
})

test('界面：等待麦克风选择保存时，快速连点不发送错误停止命令', async () => {
  const f = rendererFixture()
  const gate = deferred()
  f.api.setConfig = async () => { await gate.promise; return { asr: { audioDevice: 'endpoint-2' } } }
  vm.runInContext("scheduleSave({ asr: { audioDevice: 'endpoint-2' } })", f.context)
  const starting = f.click('btnRecordTest')
  await f.click('btnRecordTest')
  assert.equal(f.element('btnRecordTest').disabled, true)
  assert.deepEqual(f.commands, [])
  gate.resolve()
  await starting
  assert.deepEqual(f.commands, [5])
  assert.equal(f.element('btnRecordTest').textContent, '停止录制')
})

test('界面：首次状态请求迟到，不能覆盖刚开始的本地录音状态', async () => {
  const f = rendererFixture()
  const gate = deferred()
  f.api.getStatus = () => gate.promise
  vm.runInContext('diagnosticsHydrated = false', f.context)
  const refreshing = vm.runInContext('refreshStatus()', f.context)
  await f.click('btnRecordTest')
  gate.resolve({ running: false, engine: { state: 'idle' }, clickThrough: true, mock: false, packaged: false })
  await refreshing
  assert.equal(f.element('btnRecordTest').textContent, '停止录制')
  await f.click('btnRecordTest')
  assert.deepEqual(f.commands, [5, 0])
})

test('界面：再次播放先暂停旧音频，录音前也停止播放并回收 URL', async () => {
  const f = rendererFixture()
  f.result()
  await f.click('btnPlayRecording')
  await f.click('btnPlayRecording')
  assert.equal(f.audios.length, 2)
  assert.equal(f.audios[0].paused, true)
  assert.equal(f.audios[1].playbackRate, 1)
  await f.click('btnRecordTest')
  assert.equal(f.audios[1].paused, true)
  assert.equal(f.revoked.length, 2)
})

test('界面：已开始下一次录音时，迟到的文件读取不能启动回放', async () => {
  const f = rendererFixture()
  const gate = deferred()
  f.result()
  f.api.readRecording = () => gate.promise
  const playing = f.click('btnPlayRecording')
  await f.click('btnRecordTest')
  gate.resolve(Buffer.from('RIFF').toString('base64'))
  await playing
  assert.equal(f.audios.length, 0)
})

test('界面：识别和录制互斥，识别结束后恢复', async () => {
  const f = rendererFixture()
  f.result()
  await f.click('btnRecognizeTest')
  await f.click('btnRecordTest')
  assert.deepEqual(f.commands, [])
  f.events.RecognizeResult({ ok: true, text: 'test', duration: 5, loadSeconds: 0, inferSeconds: 0.1 })
  assert.equal(f.element('btnRecordTest').disabled, false)
  await f.click('btnRecordTest')
  assert.deepEqual(f.commands, [5])
})

test('界面：移除多余音频选项后，只播放当前录音且录制前停止播放', async () => {
  const f = rendererFixture()
  const kinds = []
  f.api.readRecording = async kind => { kinds.push(kind); return Buffer.from('RIFF').toString('base64') }
  // 后端仍可保留历史录音备份，但界面不再暴露参考文件播放。
  f.result({ referencePath: 'reference.wav', backend: 'mediafoundation', channels: 1 })
  assert.equal(f.element('btnPlayRecording').disabled, false)
  await f.click('btnPlayRecording')
  assert.deepEqual(kinds, ['current'])
  await f.click('btnRecordTest')
  assert.equal(f.element('btnPlayRecording').disabled, true)
  assert.equal(f.audios[0].paused, true)
})

test('界面：音频区只保留麦克风选择、刷新、录制、识别和播放', () => {
  const source = fs.readFileSync(path.join(ROOT, 'renderer/settings.html'), 'utf8')
  const section = source.slice(source.indexOf('<h2>音频输入</h2>'), source.indexOf('<h2>显示器与位置</h2>'))
  const buttons = [...section.matchAll(/<button\b[^>]*id="([^"]+)"/g)].map(match => match[1])
  assert.deepEqual(buttons, ['btnRefreshDevices', 'btnRecordTest', 'btnRecognizeTest', 'btnPlayRecording'])
  assert.doesNotMatch(section, /测试麦克风|播放原录音|wenzflow|录音采集/)
  const f = rendererFixture() // 严格按实际 DOM 提供元素，残留绑定或 disabled 引用会抛错。
  assert.equal(f.context.document.getElementById('btnTestMic'), null)
  assert.equal(f.context.document.getElementById('btnPlayReference'), null)
  f.result()
  const hints = f.element('recordResult').children.map(child => child.textContent).join('\n')
  assert.doesNotMatch(hints, /播放原录音/)
  assert.match(hints, /播放试听或识别录音/)
})

test('界面：稳定端点ID先保存再录音，多个ASR补丁不会互相覆盖', async () => {
  const f = rendererFixture()
  let stored = null
  f.api.setConfig = async patch => { stored = patch; return { asr: patch.asr } }
  f.api.testRecord = async () => {
    assert.equal(stored.asr.audioDevice, 'endpoint-guid-string')
    assert.equal(stored.asr.language, 'en')
    return true
  }
  f.element('audioDevice').value = 'endpoint-guid-string'
  f.element('audioDevice').listeners.change()
  f.element('language').value = 'en'
  f.element('language').listeners.change()
  await f.click('btnRecordTest')
  assert.equal(f.element('audioDevice').disabled, true)
})

test('界面：当前字幕是设置内容的第一张卡片，预览元素保持唯一', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer/settings.html'), 'utf8')
  const content = html.slice(html.indexOf('<main class="content">'), html.indexOf('</main>'))
  const headings = [...content.matchAll(/<h2>([^<]+)<\/h2>/g)].map(match => match[1])
  assert.equal(headings[0], '当前字幕')
  assert.equal(headings[1], '文字')
  assert.equal((content.match(/id="preview"/g) || []).length, 1)
})

test('界面：录音控件不再存在重复 DOM ID', () => {
  const source = fs.readFileSync(path.join(ROOT, 'renderer/settings.html'), 'utf8')
  const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])
  assert.equal(new Set(ids).size, ids.length)
})

function mainFixture () {
  const handlers = {}
  const reads = []
  class Bridge extends EventEmitter {
    constructor () { super(); Bridge.instance = this; this.commands = []; this.writable = true }
    start () {}
    send (message) { this.commands.push(message); return this.writable }
  }
  const app = { isPackaged: false, getPath: () => 'user-data' }
  const electron = { app, ipcMain: { handle: (name, fn) => { handlers[name] = fn } } }
  const context = vm.createContext({
    require (name) {
      if (name === 'electron') return electron
      if (name === './python-bridge') return { PythonBridge: Bridge }
      if (name === './config') return { loadConfig: () => ({ asr: { audioDevice: null } }), saveConfig () {}, DEFAULTS: {} }
      if (name === 'fs') return { existsSync: () => true, readFileSync: file => { reads.push(file); return Buffer.from('RIFF') } }
      return require(name)
    },
    __dirname: path.join(ROOT, 'electron'), process: { argv: [], env: {}, resourcesPath: 'resources' },
    console: { log () {}, error () {} }, setTimeout: () => 1, clearTimeout () {}
  })
  const source = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8')
  vm.runInContext(source.slice(0, source.indexOf('const gotLock =')), context)
  vm.runInContext('registerIpc()', context)
  return { handlers, reads, app, context, get bridge () { return Bridge.instance } }
}

test('IPC：0 明确映射 stop_record，完成后可开始下一轮', () => {
  const f = mainFixture()
  assert.equal(f.handlers['test:record'](null, 5), true)
  assert.equal(f.handlers['test:record'](null, 0), true)
  assert.deepEqual(f.bridge.commands.map(m => m.type), ['record_test', 'stop_record'])
  assert.equal(f.handlers['test:record'](null, 5), false)
  f.bridge.emit('message', { type: 'record_result', ok: true, path: 'current.wav' })
  assert.equal(f.handlers['test:record'](null, 5), true)
})

test('IPC：冷启动 idle 不撤销已提交的开始请求，运行错误保留停止入口', () => {
  const f = mainFixture()
  vm.runInContext('startBridge(); running = true', f.context)
  f.bridge.emit('message', { type: 'status', state: 'idle' })
  assert.equal(f.handlers['app:status']().running, true)
  f.bridge.emit('message', { type: 'status', state: 'error', detail: 'device error' })
  assert.equal(f.handlers['app:status']().running, true)
  f.bridge.emit('message', { type: 'status', state: 'stopped' })
  assert.equal(f.handlers['app:status']().running, false)
})

test('IPC：发送失败必须返回 false，不能报告已开始', () => {
  const f = mainFixture()
  vm.runInContext('startBridge()', f.context)
  f.bridge.writable = false
  assert.equal(f.handlers['test:record'](null, 5), false)
  assert.equal(f.handlers['app:status']().recording, false)
})

test('IPC：播放读取本次录音路径；源码模式不误读旧安装版录音', () => {
  const f = mainFixture()
  f.handlers['recording:read']()
  assert.equal(f.reads[0], path.join(ROOT, 'test_recording.wav'))
  f.handlers['test:record'](null, 5)
  f.bridge.emit('message', { type: 'record_result', ok: true, path: 'exact-current.wav' })
  assert.equal(f.handlers['recording:read'](), Buffer.from('RIFF').toString('base64'))
  assert.equal(f.reads[1], 'exact-current.wav')
})

test('IPC：后端退出清理录音状态，之后可以重启录制', () => {
  const f = mainFixture()
  f.handlers['test:record'](null, 5)
  f.bridge.emit('exit', { code: 1 })
  assert.equal(f.handlers['app:status']().recording, false)
  assert.equal(f.handlers['test:record'](null, 5), true)
})

test('IPC：参考录音读取独立备份，不冒充新录音', () => {
  const f = mainFixture()
  f.handlers['recording:read'](null, 'reference')
  assert.equal(f.reads[0], path.join(ROOT, 'test_recording_reference.wav'))
  assert.equal(f.handlers['app:status']().referenceAvailable, true)
})

test('配置：删除旧后端设置，旧数字设备迁移并提示重新确认', () => {
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'electron/config.js'), 'utf8'), {
    module, console,
    require (name) {
      if (name === 'electron') return { app: { getPath: () => 'test-user-data' } }
      if (name === 'fs') return {
        readFileSync: () => JSON.stringify({ asr: { audioDevice: 23, recordBackend: 'portaudio' } }),
        mkdirSync () {}, writeFileSync () {}
      }
      return require(name)
    }
  })
  const cfg = module.exports.loadConfig()
  assert.equal(cfg.asr.audioDevice, null)
  assert.equal(cfg.asr.audioDeviceMigrated, true)
  assert.equal(cfg.asr.recordBackend, undefined)
  const saved = module.exports.saveConfig({ asr: { audioDevice: 'endpoint-guid-string', recordBackend: 'portaudio' } })
  assert.equal(saved.asr.audioDevice, 'endpoint-guid-string')
  assert.equal(saved.asr.audioDeviceMigrated, false)
  assert.equal(saved.asr.recordBackend, undefined)
})

test('界面：移除旧采集下拉和内部实现说明', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer/settings.html'), 'utf8')
  assert.doesNotMatch(html, /id="recordBackend"|value="portaudio"|仅影响测试录音|参考 wenzflow|与 wenzflow 同类/)
  assert.doesNotMatch(html, /麦克风测试、录音和实时字幕/)
})

test('界面：设备选择使用原生ID，不再使用临时数字索引', () => {
  const f = rendererFixture()
  f.events.AudioDevices([{ id: 'endpoint-native-123', name: 'Native mic', default: true, api: 'Windows Media Foundation' }])
  assert.equal(f.element('audioDevice').children.find(option => option.value === 'endpoint-native-123').textContent, 'Native mic')
})

function configFixture (saved) {
  const module = { exports: {} }
  let written = null
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'electron/config.js'), 'utf8'), {
    module, console,
    require (name) {
      if (name === 'electron') return { app: { getPath: () => 'test-user-data' } }
      if (name === 'fs') return {
        readFileSync: () => JSON.stringify(saved),
        mkdirSync () {},
        writeFileSync: (_file, text) => { written = text }
      }
      return require(name)
    }
  })
  return { api: module.exports, written: () => written }
}

test('配置：引擎白名单与接口字段归一化', () => {
  const f = configFixture({
    asr: {
      engine: 'openai',
      apiBaseUrl: '  https://api.test/v1  ',
      apiKey: 12345,
      apiModel: '   ',
      apiLanguage: 'en',
      apiPrompt: '  专有名词  ',
      apiTimeout: 9999
    }
  })
  const cfg = f.api.loadConfig()
  // 未知引擎回落到本地默认，避免出现既无模型又无接口的悬空状态
  assert.equal(cfg.asr.engine, 'funasr')
  assert.equal(cfg.asr.apiBaseUrl, 'https://api.test/v1')
  assert.equal(cfg.asr.apiKey, '')
  assert.equal(cfg.asr.apiModel, 'whisper-1')
  assert.equal(cfg.asr.apiLanguage, 'en')
  assert.equal(cfg.asr.apiPrompt, '专有名词')
  assert.equal(cfg.asr.apiTimeout, 120)
})

test('配置：接口模式保存后保留 api 引擎并限制超时下限', () => {
  const f = configFixture({})
  const saved = f.api.saveConfig({ asr: { engine: 'api', apiBaseUrl: 'https://api.test/v1', apiTimeout: 1 } })
  assert.equal(saved.asr.engine, 'api')
  assert.equal(saved.asr.apiBaseUrl, 'https://api.test/v1')
  assert.equal(saved.asr.apiTimeout, 5)
  assert.match(f.written(), /"engine": "api"/)
})
