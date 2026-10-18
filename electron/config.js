'use strict'

const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  // 字体与配色
  fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  fontSize: 44,
  fontWeight: 700,
  color: '#FFFFFF',
  strokeColor: '#000000',
  strokeWidth: 6,
  lineGap: 12,

  // 布局
  displayId: null,      // null = 主显示器；否则存 Electron 的 display.id
  displayLabel: null,   // 显示器名称：display.id 在重启/换接口后会变，用它找回同一台屏幕
  position: 'bottom',   // bottom | top
  anchorX: 0.5,         // 水平锚点：0 = 最左，0.5 = 居中，1 = 最右
  offsetY: 120,         // 距底部/顶部的像素
  widthRatio: 0.78,     // 字幕区宽度占屏幕比例
  maxLines: 2,
  opacity: 1,

  // 行为
  showPartial: true,
  clickThrough: true,
  autoHideDelay: 10,    // 无新字幕内容多少秒后自动隐藏字幕层；0 = 不自动隐藏
  // 显示方式：realtime = 边识别边显示草稿行；sentence = 整句定稿后才显示，不出现半句
  subtitleMode: 'realtime',
  sentenceDelay: 0,     // 整句定稿后延迟多少毫秒再显示（仅 sentence 模式），0 = 定稿即显示

  // 识别引擎
  asr: {
    engine: 'funasr',       // funasr | whisper | api
    model: 'paraformer-zh-streaming',
    modelRevision: 'v2.0.4',
    modelPath: '',          // 本地模型目录，留空则按模型名从 ModelScope 下载
    puncModel: 'ct-punc',
    usePunc: true,
    device: 'cpu',          // 推理设备：cpu | cuda:0
    audioDevice: null,      // null = 系统默认，否则为稳定的 Media Foundation endpoint ID
    // 采集模式：input = 麦克风；output = 电脑声音输出（WASAPI 环回采集扬声器）
    captureSource: 'input',
    audioOutputDevice: null, // output 模式下的扬声器 endpoint ID，null = 系统默认
    cacheDir: '',           // 留空则用项目下 models/
    whisperModel: 'small',  // tiny | base | small | medium | large-v3
    computeType: 'int8',    // int8 | float16 | float32
    language: 'zh',         // zh | en | auto

    // 接口（云端 API）模式：本地只做采集，按段发给 OpenAI 兼容的转写接口
    apiBaseUrl: '',         // 例：https://api.openai.com/v1（留空表示未配置）
    apiKey: '',
    apiModel: 'whisper-1',
    apiLanguage: '',        // 留空跟随 language
    apiPrompt: '',          // 可选提示词，用于专有名词
    apiTimeout: 30          // 单次请求超时（秒），5 ~ 120
  }
}

const NUMBER_KEYS = [
  'fontSize', 'strokeWidth', 'lineGap', 'offsetY', 'maxLines',
  'opacity', 'widthRatio', 'anchorX', 'autoHideDelay', 'sentenceDelay'
]

let cache = null

function configPath () {
  return path.join(app.getPath('userData'), 'config.json')
}

function normalizeAsr (asr) {
  const next = { ...asr }
  delete next.recordBackend // capture is always Windows native, including old saved configs
  // 引擎只接受三种：本地 FunASR、本地 Whisper、云端接口
  if (!['funasr', 'whisper', 'api'].includes(next.engine)) next.engine = 'funasr'
  // 采集模式：input = 麦克风（Media Foundation）；output = 电脑声音输出（WASAPI 环回）
  next.captureSource = next.captureSource === 'output' ? 'output' : 'input'

  // 接口（云端 API）字段：文本项去空白，类型不对就回落默认值
  for (const [key, fallback] of [['apiBaseUrl', ''], ['apiKey', ''], ['apiModel', 'whisper-1'],
    ['apiLanguage', ''], ['apiPrompt', '']]) {
    const value = next[key]
    const text = typeof value === 'string' ? value.trim() : fallback
    // 模型名不能是空串，否则请求体里的 model 字段会失效
    next[key] = key === 'apiModel' && !text ? 'whisper-1' : text
  }
  const timeout = Number(next.apiTimeout)
  next.apiTimeout = Number.isFinite(timeout) ? Math.min(120, Math.max(5, Math.round(timeout))) : 30
  // 两种模式各存一个稳定 endpoint ID，互不覆盖；切换模式不用重新选设备
  for (const key of ['audioDevice', 'audioOutputDevice']) {
    const value = next[key]
    if (typeof value === 'number') {
      next[key] = null
      if (key === 'audioDevice') next.audioDeviceMigrated = true
    } else if (value != null && (typeof value !== 'string' || !value.trim())) {
      next[key] = null
    }
  }
  return next
}

function loadConfig () {
  if (cache) return cache
  let saved = {}
  try {
    saved = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
  } catch (_) { /* 首次运行没有配置文件 */ }

  cache = { ...DEFAULTS, ...saved }
  // 旧版本配置里没有 asr，这里补齐默认值
  cache.asr = normalizeAsr({ ...DEFAULTS.asr, ...(saved.asr || {}) })
  return cache
}

function saveConfig (patch) {
  const prev = loadConfig()
  const next = { ...prev, ...patch }

  // asr 是嵌套对象，必须深合并，否则只改一个字段会把其他字段抹掉
  if (patch && patch.asr && typeof patch.asr === 'object') {
    next.asr = { ...prev.asr, ...patch.asr }
  }

  next.asr = normalizeAsr(next.asr)
  // 用户明确选择了设备后清掉「已迁移/需重新确认」提示，两类端点各自独立
  if (patch && patch.asr && typeof patch.asr === 'object') {
    for (const [field, flag] of [['audioDevice', 'audioDeviceMigrated'],
      ['audioOutputDevice', 'audioOutputDeviceMigrated']]) {
      const value = patch.asr[field]
      if (Object.prototype.hasOwnProperty.call(patch.asr, field) &&
          (value == null || typeof value === 'string')) {
        next.asr[flag] = false
      }
    }
  }

  for (const key of NUMBER_KEYS) {
    if (key in next) {
      const n = Number(next[key])
      if (Number.isFinite(n)) next[key] = n
    }
  }

  if ('anchorX' in next) next.anchorX = Math.min(1, Math.max(0, next.anchorX))
  if ('opacity' in next) next.opacity = Math.min(1, Math.max(0, next.opacity))
  if ('widthRatio' in next) next.widthRatio = Math.min(1, Math.max(0.1, next.widthRatio))
  // 自动隐藏耗时：0 表示关闭，最多 1 小时，避免误填导致永远不隐藏/立刻隐藏
  if ('autoHideDelay' in next) {
    next.autoHideDelay = Math.min(3600, Math.max(0, Math.round(next.autoHideDelay)))
  }

  // 显示方式：只接受 realtime / sentence，其它值回落到实时
  if (!['realtime', 'sentence'].includes(next.subtitleMode)) next.subtitleMode = 'realtime'
  // 整句定稿延时：0 ~ 10 秒，避免误填导致字幕长时间不出现
  if ('sentenceDelay' in next) {
    next.sentenceDelay = Math.min(10000, Math.max(0, Math.round(next.sentenceDelay)))
  }

  cache = next
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true })
    fs.writeFileSync(configPath(), JSON.stringify(cache, null, 2), 'utf8')
  } catch (err) {
    console.error('[config] 写入失败:', err)
  }
  return cache
}

module.exports = { loadConfig, saveConfig, DEFAULTS, configPath }
