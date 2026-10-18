'use strict'
// 只执行主进程中与字幕分发相关的逻辑，不启动 Electron、不访问音频设备。
// 覆盖：实时模式 / 整句定稿模式 / 定稿延时 / 延时内新句替换 / 停止清队列 / 切换模式。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const ROOT = path.join(__dirname, '..')

function mainFixture (initial = {}) {
  const handlers = {}
  const sent = []
  const timers = new Map()
  let nextTimer = 1
  const cfg = {
    autoHideDelay: 0,
    subtitleMode: 'realtime',
    sentenceDelay: 0,
    clickThrough: true,
    asr: { audioDevice: null },
    ...initial
  }
  class Bridge extends EventEmitter {
    constructor () { super(); Bridge.instance = this; this.commands = [] }
    start () {}
    send (message) { this.commands.push(message); return true }
  }
  const app = { isPackaged: false, getPath: () => 'user-data' }
  const electron = { app, ipcMain: { handle: (name, fn) => { handlers[name] = fn } } }
  const context = vm.createContext({
    require (name) {
      if (name === 'electron') return electron
      if (name === './python-bridge') return { PythonBridge: Bridge }
      if (name === './config') {
        return {
          loadConfig: () => cfg,
          saveConfig: patch => { Object.assign(cfg, patch || {}); return cfg },
          DEFAULTS: {}
        }
      }
      if (name === 'fs') return { existsSync: () => false, readFileSync: () => Buffer.from('') }
      return require(name)
    },
    __dirname: path.join(ROOT, 'electron'),
    process: { argv: [], env: {}, resourcesPath: 'resources' },
    console: { log () {}, error () {} },
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id },
    clearTimeout: id => { timers.delete(id) },
    __capture: (channel, payload) => sent.push({ channel, payload })
  })
  const source = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8')
  vm.runInContext(source.slice(0, source.indexOf('const gotLock =')), context)
  // 接管字幕下发目标，便于断言真正推给字幕层的内容
  vm.runInContext(
    'overlayWin = { isDestroyed: () => false, webContents: { send: (c, p) => __capture(c, p) } }',
    context
  )
  vm.runInContext('registerIpc()', context)
  vm.runInContext('startBridge()', context)
  // startBridge 内部有一个 400ms 的预热定时器，不属于字幕逻辑，先清掉
  timers.clear()

  const flush = () => {
    for (const [id, entry] of [...timers]) {
      timers.delete(id)
      entry.fn()
    }
  }
  // 跨 vm 上下文的对象原型不同，deepStrictEqual 会因原型不一致报错，
  // 这里只比较结构化的值本身。
  const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value))
  const lastSubtitle = () => {
    const hit = sent.filter(item => item.channel === 'subtitle:state')
    return hit.length ? plain(hit[hit.length - 1].payload) : null
  }
  const state = () => JSON.parse(vm.runInContext('JSON.stringify(subtitle)', context))

  return {
    handlers,
    sent,
    timers,
    cfg,
    context,
    bridge: Bridge.instance,
    emit: msg => Bridge.instance.emit('message', msg),
    flush,
    lastSubtitle,
    state,
    plain
  }
}

test('实时模式：草稿与定稿都立即下发给字幕层', () => {
  const f = mainFixture()
  f.emit({ type: 'partial', text: '今天' })
  assert.deepEqual(f.lastSubtitle(), { final: '', partial: '今天' })
  f.emit({ type: 'final', text: '今天聊字幕。' })
  assert.deepEqual(f.lastSubtitle(), { final: '今天聊字幕。', partial: '' })
})

test('整句模式：草稿不下发，定稿后才整句出现', () => {
  const f = mainFixture({ subtitleMode: 'sentence' })
  f.emit({ type: 'partial', text: '今天' })
  f.emit({ type: 'partial', text: '今天聊' })
  assert.equal(f.lastSubtitle(), null, '草稿不能推给字幕层')
  assert.deepEqual(f.state(), { final: '', partial: '' })

  f.emit({ type: 'final', text: '今天聊字幕。' })
  assert.deepEqual(f.lastSubtitle(), { final: '今天聊字幕。', partial: '' })
  assert.deepEqual(f.state(), { final: '今天聊字幕。', partial: '' })
})

test('整句模式：定稿延时期间不显示，到点后才出现', () => {
  const f = mainFixture({ subtitleMode: 'sentence', sentenceDelay: 600 })
  f.emit({ type: 'final', text: '第一句。' })
  assert.equal(f.lastSubtitle(), null, '延时期间不能提前显示')
  assert.equal(f.timers.size, 1)
  const [, entry] = [...f.timers][0]
  assert.equal(entry.ms, 600)

  f.flush()
  assert.deepEqual(f.lastSubtitle(), { final: '第一句。', partial: '' })
})

test('整句模式：延时里来了新整句，只显示最新一句', () => {
  const f = mainFixture({ subtitleMode: 'sentence', sentenceDelay: 500 })
  f.emit({ type: 'final', text: '第一句。' })
  f.emit({ type: 'final', text: '第二句。' })
  assert.equal(f.timers.size, 1, '旧的延时应被打断，不能排两句')

  f.flush()
  const shown = f.sent.filter(item => item.channel === 'subtitle:state')
  assert.equal(shown.length, 1)
  assert.deepEqual(f.plain(shown[0].payload), { final: '第二句。', partial: '' })
})

test('整句模式：停止识别会丢弃还没显示的整句', () => {
  const f = mainFixture({ subtitleMode: 'sentence', sentenceDelay: 500 })
  f.emit({ type: 'final', text: '来不及显示的一句。' })
  vm.runInContext('running = true', f.context)
  f.handlers['engine:toggle']()

  assert.equal(f.timers.size, 0)
  f.flush()
  assert.equal(f.sent.filter(item => item.channel === 'subtitle:state').length, 0)
})

test('切回实时模式：丢掉待显示整句，草稿恢复正常下发', () => {
  const f = mainFixture({ subtitleMode: 'sentence', sentenceDelay: 500 })
  f.emit({ type: 'final', text: '待显示的整句。' })
  f.handlers['config:set'](null, { subtitleMode: 'realtime' })

  assert.equal(f.timers.size, 0)
  f.emit({ type: 'partial', text: '新的草稿' })
  assert.deepEqual(f.lastSubtitle(), { final: '', partial: '新的草稿' })
})

test('切到整句模式：屏幕上残留的半句草稿被清掉', () => {
  const f = mainFixture()
  f.emit({ type: 'partial', text: '半句草稿' })
  assert.deepEqual(f.lastSubtitle(), { final: '', partial: '半句草稿' })

  f.handlers['config:set'](null, { subtitleMode: 'sentence' })
  assert.deepEqual(f.state(), { final: '', partial: '' })
  assert.deepEqual(f.lastSubtitle(), { final: '', partial: '' })
})

test('配置：显示方式只接受 realtime / sentence，延时限制在 0~10000 毫秒', () => {
  const module = { exports: {} }
  const saved = {}
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'electron/config.js'), 'utf8'), {
    module,
    console,
    require (name) {
      if (name === 'electron') return { app: { getPath: () => 'test-user-data' } }
      if (name === 'fs') return {
        readFileSync: () => JSON.stringify(saved.value || {}),
        mkdirSync () {},
        writeFileSync: (_file, content) => { saved.value = JSON.parse(content) }
      }
      return require(name)
    }
  })

  const cfg = module.exports.saveConfig({ subtitleMode: 'unknown', sentenceDelay: 999999 })
  assert.equal(cfg.subtitleMode, 'realtime')
  assert.equal(cfg.sentenceDelay, 10000)

  assert.equal(module.exports.saveConfig({ sentenceDelay: -20 }).sentenceDelay, 0)
  assert.equal(module.exports.saveConfig({ subtitleMode: 'sentence' }).subtitleMode, 'sentence')
})
