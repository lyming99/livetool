'use strict'

const $ = (id) => document.getElementById(id)

let cfg = null
let syncing = false
let saveTimer = null
let pending = {}
let audioDevices = []
// 扬声器（电脑声音输出）端点；采集模式为 output 时用它
let audioOutputDevices = []
let installLines = []
let lastRecordingPath = null
let recording = false
let recordStarting = false
let recordStopping = false
let micTesting = false
let recognizing = false
let engineRunning = false
let diagnosticsHydrated = false
let reloadingEngine = false
let savePromise = Promise.resolve()
let recordingAudio = null
let recordingAudioUrl = null
let playbackGeneration = 0
// 最近一次读到的显示器列表：切换显示器时需要从中取名称一起存
let lastDisplays = []
// 字幕层显隐是运行时状态（不写配置），单独记一份，避免被 fill() 回填成「显示」
let overlayVisibleState = true

// 这几项在配置里存 0~1 的小数，界面上用百分数显示
const RATIO_KEYS = new Set(['widthRatio', 'opacity', 'anchorX'])

const RANGE_KEYS = ['fontSize', 'strokeWidth', 'offsetY', 'anchorX', 'widthRatio', 'lineGap', 'maxLines', 'opacity']

// 界面控件 id -> 配置里 asr 的字段名
const ASR_FIELDS = {
  asrModel: 'model',
  asrModelRevision: 'modelRevision',
  asrModelPath: 'modelPath',
  asrPuncModel: 'puncModel',
  asrDevice: 'device',
  asrCacheDir: 'cacheDir',
  asrUsePunc: 'usePunc',
  whisperModel: 'whisperModel',
  computeType: 'computeType',
  language: 'language',
  // 接口（云端 API）模式
  apiBaseUrl: 'apiBaseUrl',
  apiKey: 'apiKey',
  apiModel: 'apiModel',
  apiLanguage: 'apiLanguage',
  apiPrompt: 'apiPrompt',
  apiTimeout: 'apiTimeout'
}

const STATE_TEXT = {
  idle: '未启动',
  starting: '加载中',
  loading: '加载中',
  ready: '就绪',
  running: '识别中',
  stopped: '已停止',
  error: '出错'
}

// 安装版没有 FunASR，只在第一次拿到状态时处理一次
let capabilitiesApplied = false

function applyCapabilities (status) {
  const note = $('engineNote')

  if (!status.packaged) {
    note.textContent = '源码模式：FunASR、Whisper 两个本地引擎，以及接口（云端 API）都可以用。'
    return
  }

  note.textContent = '安装版内置 FunASR 和 Whisper 两个本地引擎（首次使用需要下载对应模型）；也可以选「接口（云端 API）」，本地只做采集，不下载模型。'
}

/** 引擎切换时的补充说明：接口模式不需要本地模型与推理设备 */
function renderEngineHint (engine) {
  const api = engine === 'api'

  const installHint = $('installHint')
  if (installHint) {
    installHint.textContent = api
      ? '接口模式不用下载模型：填好接口地址、密钥和模型名后，直接点「开始识别」即可；改完配置点「重新加载模型」生效。'
      : '首次使用先点「一键安装」补齐依赖并下载模型；改完配置后点「重新加载模型」生效。'
  }

  const installBtn = $('btnInstall')
  if (installBtn) installBtn.textContent = api ? '校验接口配置' : '一键安装 / 下载模型'
}

/* ---------------- 数值映射 ---------------- */

function toStore (key, v) {
  return RATIO_KEYS.has(key) ? Number(v) / 100 : Number(v)
}

function toUi (key, v) {
  return RATIO_KEYS.has(key) ? Math.round(Number(v) * 100) : v
}

function outText (key, uiVal) {
  return RATIO_KEYS.has(key) ? Math.round(uiVal) + '%' : String(Math.round(uiVal))
}

/* ---------------- 填充与回写 ---------------- */

/** 显示方式联动：整句模式不用草稿开关，实时模式不看定稿延时 */
function renderModeHint (mode, delayMs) {
  const sentence = mode === 'sentence'
  const n = Number(delayMs)

  const modeEl = $('subtitleModeHint')
  if (modeEl) {
    modeEl.textContent = sentence
      ? '整句定稿后才出现：屏幕上不会出现半句草稿，只在识别出一整句后显示。'
      : '实时显示：识别中的草稿行也会先出现（可关闭下方「草稿行」）。'
  }

  const partialEl = $('showPartial')
  if (partialEl) {
    partialEl.disabled = sentence
    const label = partialEl.closest && partialEl.closest('.switch')
    if (label) label.classList.toggle('disabled', sentence)
  }

  const delayEl = $('sentenceDelay')
  if (delayEl) delayEl.disabled = !sentence

  const delayHint = $('sentenceDelayHint')
  if (delayHint) {
    delayHint.textContent = sentence
      ? (Number.isFinite(n) && n > 0
          ? '整句定稿后会再等 ' + n + ' 毫秒才显示；期间若出现新的一句，直接换成新的整句。'
          : '整句定稿后立即显示，不再额外等待。')
      : '当前是实时显示，定稿延时只在「整句定稿后显示」时生效。'
  }
}

/** 自动隐藏耗时的提示文案：0 表示关闭 */
function renderAutoHideHint (seconds) {
  const el = $('autoHideHint')
  if (!el) return
  const n = Number(seconds)
  el.textContent = !Number.isFinite(n) || n <= 0
    ? '已关闭自动隐藏：字幕层会一直保持显示，直到你手动隐藏'
    : `没有新字幕内容超过 ${n} 秒后自动隐藏字幕层；出现新字幕会重新显示`
}

function fill (c) {
  syncing = true

  $('fontFamily').value = c.fontFamily
  if ($('fontFamily').selectedIndex < 0) $('fontFamily').selectedIndex = 0
  $('fontWeight').value = String(c.fontWeight)
  $('fontSize').value = c.fontSize
  $('color').value = c.color
  $('strokeColor').value = c.strokeColor
  $('strokeWidth').value = c.strokeWidth

  $('position').value = c.position
  $('offsetY').value = c.offsetY
  $('anchorX').value = toUi('anchorX', c.anchorX)
  $('widthRatio').value = toUi('widthRatio', c.widthRatio)
  $('lineGap').value = c.lineGap
  $('maxLines').value = c.maxLines
  $('opacity').value = toUi('opacity', c.opacity)

  $('showPartial').checked = !!c.showPartial
  // 显示方式：realtime = 实时显示；sentence = 整句定稿后才显示
  const subtitleMode = c.subtitleMode === 'sentence' ? 'sentence' : 'realtime'
  $('subtitleMode').value = subtitleMode
  const sentenceDelay = Number.isFinite(Number(c.sentenceDelay)) ? Number(c.sentenceDelay) : 0
  $('sentenceDelay').value = sentenceDelay
  renderModeHint(subtitleMode, sentenceDelay)
  $('clickThrough').checked = c.clickThrough !== false
  // 无内容自动隐藏耗时（秒）：0 = 关闭
  const autoHideSeconds = Number.isFinite(Number(c.autoHideDelay)) ? Number(c.autoHideDelay) : 10
  $('autoHideDelay').value = autoHideSeconds
  renderAutoHideHint(autoHideSeconds)
  // 显隐不写配置，用运行时状态，避免每次回填都跳回「显示」
  $('overlayVisible').checked = overlayVisibleState !== false

  $('asrEngine').value = c.asr.engine || 'funasr'
  $('asrModel').value = c.asr.model || ''
  $('asrModelRevision').value = c.asr.modelRevision || ''
  $('asrModelPath').value = c.asr.modelPath || ''
  $('asrPuncModel').value = c.asr.puncModel || ''
  $('asrDevice').value = c.asr.device || 'cpu'
  $('asrCacheDir').value = c.asr.cacheDir || ''
  $('asrUsePunc').checked = c.asr.usePunc !== false
  $('whisperModel').value = c.asr.whisperModel || 'small'
  $('computeType').value = c.asr.computeType || 'int8'
  $('language').value = c.asr.language || 'zh'

  $('apiBaseUrl').value = c.asr.apiBaseUrl || ''
  $('apiKey').value = c.asr.apiKey || ''
  $('apiModel').value = c.asr.apiModel || 'whisper-1'
  // 接口语言留空时跟随上面的「识别语言」
  const apiLanguage = c.asr.apiLanguage || c.asr.language || 'zh'
  $('apiLanguage').value = ['zh', 'en', 'auto'].includes(apiLanguage) ? apiLanguage : 'zh'
  $('apiPrompt').value = c.asr.apiPrompt || ''
  const apiTimeout = Number.isFinite(Number(c.asr.apiTimeout)) ? Number(c.asr.apiTimeout) : 30
  $('apiTimeout').value = Math.min(120, Math.max(5, Math.round(apiTimeout)))
  // 采集模式：input = 麦克风；output = 电脑声音输出（WASAPI 环回）
  $('captureSource').value = c.asr.captureSource === 'output' ? 'output' : 'input'

  syncEngineBlocks()
  syncing = false
  updateOutputs()
  renderAudioDevices()
}

function updateOutputs () {
  for (const key of RANGE_KEYS) {
    const el = $(key)
    const out = $(key + 'Out')
    if (el && out) out.textContent = outText(key, Number(el.value))
  }
}

function syncEngineBlocks () {
  const engine = $('asrEngine').value
  for (const block of document.querySelectorAll('.engine-block')) {
    block.classList.toggle('active', block.dataset.engine === engine)
  }
  renderEngineHint(engine)
}

/* ---------------- 显示器 ---------------- */

/**
 * 读取显示器列表。
 * refresh=true 时让主进程重新扫描并重新贴合字幕窗（系统改过分辨率/缩放率后用）。
 */
async function loadDisplays (refresh = false) {
  let list = []
  try {
    list = refresh
      ? await window.settingsAPI.refreshDisplays()
      : await window.settingsAPI.getDisplays()
  } catch (_) {
    return
  }
  if (!Array.isArray(list)) list = []
  lastDisplays = list

  const select = $('displayId')
  const current = cfg ? cfg.displayId : null
  const savedLabel = cfg ? cfg.displayLabel : null

  // 重建 option 时可能触发 change，用 syncing 挡掉，避免把「当前选中」
  // 当成用户操作写回配置
  syncing = true
  select.innerHTML = ''

  const primaryOpt = document.createElement('option')
  primaryOpt.value = 'primary'
  primaryOpt.textContent = '跟随主显示器'
  select.appendChild(primaryOpt)

  for (const d of list) {
    const opt = document.createElement('option')
    opt.value = String(d.id)
    const scale = d.scaleFactor && d.scaleFactor !== 1
      ? ` · 缩放 ${Math.round(d.scaleFactor * 100)}%`
      : ''
    const primary = d.primary ? '（主屏）' : ''
    opt.textContent = `${d.label}${primary} · ${d.width}×${d.height}${scale}`
    opt.title = `可用区 ${d.workWidth}×${d.workHeight} · 位置 ${d.x},${d.y}`
    select.appendChild(opt)
  }

  let selected = 'primary'
  if (current != null) {
    if (list.some((d) => String(d.id) === String(current))) {
      selected = String(current)
    } else if (savedLabel) {
      // display.id 在换接口/重启后可能变，用名称找回同一台屏
      const byName = list.find((d) => (d.label || '') === savedLabel)
      if (byName) selected = String(byName.id)
    }
  }
  select.value = selected
  syncing = false

  renderDisplayInfo(list)
}

/** 把当前目标显示器的分辨率、可用区和缩放率显示出来，方便判断字幕位置是否对得上 */
function renderDisplayInfo (list) {
  const el = $('displayInfo')
  if (!el) return
  if (!list || !list.length) {
    el.textContent = '未检测到显示器，可点「刷新」重新扫描'
    return
  }

  const current = cfg ? cfg.displayId : null
  const target = current == null
    ? (list.find((d) => d.primary) || list[0])
    : (list.find((d) => String(d.id) === String(current)) || list.find((d) => d.primary) || list[0])
  if (!target) return

  const scale = Math.round((target.scaleFactor || 1) * 100)
  const work = (target.workWidth && target.workHeight)
    ? ` · 可用区 ${target.workWidth}×${target.workHeight}`
    : ''
  const rotate = target.rotation ? ` · 旋转 ${target.rotation}°` : ''
  el.textContent =
    `当前字幕屏：${target.label}${target.primary ? '（主屏）' : ''} · 分辨率 ${target.width}×${target.height}${work} · 缩放 ${scale}%${rotate} · 起点 ${target.x},${target.y}`
}

/* ---------------- 音频设备（麦克风 / 电脑声音输出） ---------------- */

/** 当前采集模式：input = 麦克风；output = 电脑声音输出（WASAPI 环回） */
function currentCaptureKind () {
  return cfg && cfg.asr && cfg.asr.captureSource === 'output' ? 'output' : 'input'
}

/** 采集模式对应的设备目录 */
function currentDeviceCatalog () {
  return currentCaptureKind() === 'output' ? audioOutputDevices : audioDevices
}

/** 采集模式相关的标签、提示与可用性 */
function renderCaptureMode (busy) {
  const output = currentCaptureKind() === 'output'
  const captured = typeof busy === 'boolean' ? busy : (recording || micTesting)

  const label = $('audioDeviceLabel')
  if (label) label.textContent = output ? '扬声器' : '麦克风'

  const hint = $('captureSourceHint')
  if (hint) {
    hint.textContent = output
      ? '电脑声音输出：采集所选扬声器正在播放的声音（游戏、播放器、会议等），与麦克风无关。'
      : '麦克风：采集你说话的语音。'
  }

  // 录制/测试进行中不允许换来源，避免中途换设备
  const select = $('captureSource')
  if (select) select.disabled = captured

  const recordBtn = $('btnRecordTest')
  if (recordBtn) {
    recordBtn.title = output
      ? (engineRunning ? '请先停止实时识别，再录制电脑声音' : '录制所选扬声器正在播放的声音')
      : (engineRunning ? '请先停止实时识别，再录制测试音频' : '')
  }
}

function renderAudioDevices () {
  if (!cfg) return

  const output = currentCaptureKind() === 'output'
  const catalog = output ? audioOutputDevices : audioDevices
  const current = output ? cfg.asr.audioOutputDevice : cfg.asr.audioDevice
  const select = $('audioDevice')

  syncing = true
  select.innerHTML = ''

  // 「系统默认」直接把实际设备名带上，省得用户猜默认到底是哪一个
  const defaultDev = catalog.find((d) => d.default)
  const defaultOpt = document.createElement('option')
  defaultOpt.value = 'default'
  defaultOpt.textContent = defaultDev ? `系统默认（${defaultDev.name}）` : '系统默认'
  select.appendChild(defaultOpt)

  for (const d of catalog) {
    const opt = document.createElement('option')
    opt.value = d.id
    opt.textContent = d.name
    opt.title = d.api || ''
    select.appendChild(opt)
  }

  if (current != null && !catalog.some(d => d.id === current)) {
    const missing = document.createElement('option')
    missing.value = current
    missing.textContent = output
      ? '已保存的扬声器不可用，请刷新或重新选择'
      : '已保存的麦克风不可用，请刷新或重新选择'
    missing.disabled = true
    select.appendChild(missing)
  }
  select.value = current == null ? 'default' : current
  syncing = false

  renderCaptureMode()

  if (!catalog.length) {
    $('audioHint').textContent = output
      ? '未检测到扬声器，请检查系统是否已连接输出设备'
      : '未检测到原生麦克风，请检查设备、系统权限和原生采集组件'
    return
  }
  $('audioHint').textContent = output
    ? `检测到 ${catalog.length} 个扬声器（电脑声音输出）${cfg.asr.audioOutputDeviceMigrated ? ' · 已保存的扬声器不可用，请重新选择' : ''}`
    : `检测到 ${catalog.length} 个原生麦克风${cfg.asr.audioDeviceMigrated ? ' · 旧设备编号已重置为系统默认，请确认麦克风选择' : ''}`
}

/* ---------------- 保存 ---------------- */

function flushSave () {
  clearTimeout(saveTimer)
  if (Object.keys(pending).length) {
    const body = pending
    pending = {}
    savePromise = savePromise.catch(() => {}).then(async () => {
      cfg = await window.settingsAPI.setConfig(body)
    })
  }
  return savePromise
}

function scheduleSave (patch) {
  const asr = patch.asr ? { ...(pending.asr || {}), ...patch.asr } : null
  Object.assign(pending, patch)
  if (asr) pending.asr = asr
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => flushSave().catch(console.error), 60)
}

function syncAudioControls () {
  $('btnRecordTest').disabled = recordStarting || recordStopping || micTesting || recognizing || engineRunning
  $('btnRecordTest').textContent = recordStarting ? '正在启动…' : recordStopping ? '正在停止…' : recording ? '停止录制' : '录制 5 秒'
  // 采集模式决定按钮提示（麦克风 / 电脑声音），统一由 renderCaptureMode 维护
  renderCaptureMode()
  $('audioDevice').disabled = recording || micTesting
  $('btnRefreshDevices').disabled = recording || micTesting
  $('btnPlayRecording').disabled = recording || micTesting || recognizing || !lastRecordingPath
  $('btnRecognizeTest').disabled = recording || micTesting || recognizing || !lastRecordingPath
  $('btnToggle').disabled = recording || micTesting || recognizing
  $('btnReloadModel').disabled = recording || micTesting || recognizing || reloadingEngine
}

function finishRecordingUi () {
  recording = false
  recordStarting = false
  recordStopping = false
  $('recordMeter').classList.remove('show')
  syncAudioControls()
}

function stopRecordingPlayback () {
  playbackGeneration++
  if (recordingAudio) {
    recordingAudio.pause()
    recordingAudio.removeAttribute('src')
    recordingAudio.load()
    recordingAudio = null
  }
  if (recordingAudioUrl) URL.revokeObjectURL(recordingAudioUrl)
  recordingAudioUrl = null
}

async function playRecording () {
  if (recording || micTesting || recognizing || !lastRecordingPath) return
  stopRecordingPlayback()
  const generation = playbackGeneration
  try {
    const b64 = await window.settingsAPI.readRecording('current')
    if (generation !== playbackGeneration) return
    if (!b64) throw new Error('读不到录音文件')
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    recordingAudioUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
    const audio = new Audio(recordingAudioUrl)
    recordingAudio = audio
    audio.playbackRate = 1
    audio.addEventListener('ended', () => {
      if (recordingAudio === audio) stopRecordingPlayback()
    }, { once: true })
    await audio.play()
  } catch (err) {
    if (generation !== playbackGeneration) return
    stopRecordingPlayback()
    $('recordResult').textContent = '播放失败：' + err.message
  }
}

/* ---------------- 环境与安装 ---------------- */

function renderEnv (state) {
  const box = $('envBox')
  if (!state) {
    box.textContent = '暂无环境信息'
    return
  }
  if (!state.deps || state.deps.length === 0) {
    box.textContent = state.error || '暂无环境信息'
    return
  }

  box.innerHTML = ''
  for (const dep of state.deps) {
    const line = document.createElement('div')
    line.className = dep.installed ? 'ok' : 'bad'
    line.textContent = `${dep.installed ? '✓ 已安装' : '✗ 未安装'}  ${dep.package}`
    box.appendChild(line)
  }

  const summary = document.createElement('div')
  summary.textContent = state.ready
    ? '依赖齐全，可以直接开始识别'
    : '还缺依赖，点「一键安装 / 下载模型」补齐'
  box.appendChild(summary)
}

function appendInstallLog (text) {
  if (!text) return
  installLines.push(text)
  if (installLines.length > 300) installLines = installLines.slice(-300)
  const el = $('installLog')
  el.classList.add('show')
  el.textContent = installLines.join('\n')
  el.scrollTop = el.scrollHeight
}

/* ---------------- 事件绑定 ---------------- */

function bindAll () {
  for (const key of RANGE_KEYS) {
    const el = $(key)
    el.addEventListener('input', () => {
      if (syncing) return
      $(key + 'Out').textContent = outText(key, Number(el.value))
      scheduleSave({ [key]: toStore(key, el.value) })
    })
  }

  $('fontFamily').addEventListener('change', () => {
    if (!syncing) scheduleSave({ fontFamily: $('fontFamily').value })
  })

  $('fontWeight').addEventListener('change', () => {
    if (!syncing) scheduleSave({ fontWeight: Number($('fontWeight').value) })
  })

  $('position').addEventListener('change', () => {
    if (!syncing) scheduleSave({ position: $('position').value })
  })

  for (const key of ['color', 'strokeColor']) {
    $(key).addEventListener('input', () => {
      if (!syncing) scheduleSave({ [key]: $(key).value })
    })
  }

  $('showPartial').addEventListener('change', () => {
    if (!syncing) scheduleSave({ showPartial: $('showPartial').checked })
  })

  $('subtitleMode').addEventListener('change', () => {
    if (syncing) return
    const mode = $('subtitleMode').value === 'sentence' ? 'sentence' : 'realtime'
    scheduleSave({ subtitleMode: mode })
    renderModeHint(mode, $('sentenceDelay').value)
  })

  // 定稿延时：0 ~ 10000 毫秒，只影响「整句定稿后显示」
  $('sentenceDelay').addEventListener('input', () => {
    if (syncing) return
    const raw = Number($('sentenceDelay').value)
    if (!Number.isFinite(raw)) return
    const ms = Math.min(10000, Math.max(0, Math.round(raw)))
    scheduleSave({ sentenceDelay: ms })
    renderModeHint($('subtitleMode').value, ms)
  })

  $('sentenceDelay').addEventListener('blur', () => {
    if (syncing) return
    const raw = Number($('sentenceDelay').value)
    const ms = Number.isFinite(raw) ? Math.min(10000, Math.max(0, Math.round(raw))) : 0
    $('sentenceDelay').value = ms
    scheduleSave({ sentenceDelay: ms })
    renderModeHint($('subtitleMode').value, ms)
  })

  // 自动隐藏耗时：只接受 0 ~ 3600 的整数，0 表示关闭
  $('autoHideDelay').addEventListener('input', () => {
    if (syncing) return
    const raw = Number($('autoHideDelay').value)
    if (!Number.isFinite(raw)) return
    const seconds = Math.min(3600, Math.max(0, Math.round(raw)))
    scheduleSave({ autoHideDelay: seconds })
    renderAutoHideHint(seconds)
  })

  $('autoHideDelay').addEventListener('blur', () => {
    if (syncing) return
    const raw = Number($('autoHideDelay').value)
    const seconds = Number.isFinite(raw) ? Math.min(3600, Math.max(0, Math.round(raw))) : 10
    $('autoHideDelay').value = seconds
    renderAutoHideHint(seconds)
    scheduleSave({ autoHideDelay: seconds })
  })

  $('clickThrough').addEventListener('change', async () => {
    if (syncing) return
    await window.settingsAPI.setClickThrough($('clickThrough').checked)
  })

  /* ---- 字幕层显示 / 隐藏 ---- */

  $('overlayVisible').addEventListener('change', async () => {
    if (syncing) return
    const visible = await window.settingsAPI.setOverlayVisible($('overlayVisible').checked)
    $('overlayVisible').checked = visible !== false
  })

  $('btnShowOverlay').addEventListener('click', async () => {
    const visible = await window.settingsAPI.setOverlayVisible(true)
    $('overlayVisible').checked = visible !== false
  })

  $('btnHideOverlay').addEventListener('click', async () => {
    const visible = await window.settingsAPI.setOverlayVisible(false)
    $('overlayVisible').checked = visible !== false
  })

  /* ---- 预览测试文字 ---- */

  async function applyPreview () {
    const text = $('previewText').value || ''
    await window.settingsAPI.previewText(text)
    $('previewHint').textContent = text
      ? '预览中：字幕层正在显示这段测试文字，点「清除预览」恢复真实识别结果'
      : '预览已清除，字幕层恢复显示识别结果'
  }

  $('btnPreviewApply').addEventListener('click', applyPreview)

  $('previewText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyPreview()
  })

  $('btnPreviewClear').addEventListener('click', async () => {
    await window.settingsAPI.previewText('')
    $('previewHint').textContent = '预览已清除，字幕层恢复显示识别结果'
  })

  /* ---- 显示器 ---- */

  $('displayId').addEventListener('change', () => {
    if (syncing) return
    const v = $('displayId').value
    if (v === 'primary') {
      scheduleSave({ displayId: null, displayLabel: null })
      return
    }
    // 同时存显示器名称：display.id 在换接口、重启或改缩放后可能变，靠名称找回同一台屏
    const picked = lastDisplays.find((d) => String(d.id) === String(v))
    scheduleSave({ displayId: Number(v), displayLabel: picked ? (picked.label || null) : null })
  })

  $('btnRefreshDisplays').addEventListener('click', async () => {
    const btn = $('btnRefreshDisplays')
    btn.disabled = true
    btn.textContent = '刷新中…'
    try {
      // 先落盘待保存的显示器选择，再让主进程重新扫描并重新贴合字幕层
      await flushSave()
      await loadDisplays(true)
      $('displayHint').textContent = '已重新读取显示器分辨率与缩放率，字幕层已按新尺寸重新贴合'
    } catch (err) {
      $('displayHint').textContent = '刷新失败：' + err.message
    } finally {
      btn.disabled = false
      btn.textContent = '刷新'
    }
  })

  /* ---- 采集模式与设备 ---- */

  // 切换麦克风 / 电脑声音输出：两种来源各存各自的设备，切换后重新渲染列表
  $('captureSource').addEventListener('change', () => {
    if (syncing) return
    const captureSource = $('captureSource').value === 'output' ? 'output' : 'input'
    cfg.asr.captureSource = captureSource
    renderAudioDevices()
    renderCaptureMode()
    scheduleSave({ asr: { captureSource } })
  })

  $('audioDevice').addEventListener('change', () => {
    if (syncing) return
    const v = $('audioDevice').value
    const device = v === 'default' ? null : v
    // 采集模式不同，保存到不同字段，互不覆盖
    if (currentCaptureKind() === 'output') {
      cfg.asr.audioOutputDevice = device
      cfg.asr.audioOutputDeviceMigrated = false
      scheduleSave({ asr: { audioOutputDevice: device } })
    } else {
      cfg.asr.audioDevice = device
      cfg.asr.audioDeviceMigrated = false
      scheduleSave({ asr: { audioDevice: device } })
    }
  })

  $('btnRefreshDevices').addEventListener('click', () => {
    window.settingsAPI.getAudioDevices()
  })

  $('btnRecordTest').addEventListener('click', async () => {
    if (recordStarting || recordStopping) return
    if (recording) {
      recordStopping = true
      syncAudioControls()
      $('recordResult').textContent = '正在停止录制并保存…'
      try {
        if (!await window.settingsAPI.testRecord(0)) throw new Error('录音已结束，请重新录制')
      } catch (err) {
        finishRecordingUi()
        $('recordResult').textContent = err.message
      }
      return
    }
    if (micTesting || recognizing || engineRunning) return
    stopRecordingPlayback()
    const fromOutput = currentCaptureKind() === 'output'
    const box = $('recordResult')
    box.className = 'rec-box show'
    box.textContent = fromOutput
      ? '正在准备录制电脑声音，请稍候…（显示「正在录制」后播放声音）'
      : '正在准备录音，请稍候…（显示「正在录制」后再说话）'
    diagnosticsHydrated = true
    recording = true
    recordStarting = true
    lastRecordingPath = null
    syncAudioControls()
    $('recordMeter').classList.add('show')
    $('recordMeterFill').style.width = '2%'
    $('recordMeterFill').style.background = '#475569'
    $('recordMeterText').textContent = fromOutput ? '正在打开扬声器…' : '正在打开麦克风…'
    try {
      // 等设备选择保存完成，避免刚切换设备就录到旧设备。
      await flushSave()
      if (!await window.settingsAPI.testRecord(5)) throw new Error('无法启动录音，请重试')
      recordStarting = false
      syncAudioControls()
    } catch (err) {
      finishRecordingUi()
      box.textContent = '录制失败：' + err.message
    }
  })

  $('btnRecognizeTest').addEventListener('click', async () => {
    if (recording || micTesting || recognizing || !lastRecordingPath) return
    stopRecordingPlayback()
    diagnosticsHydrated = true
    recognizing = true
    syncAudioControls()
    const box = $('recordResult')
    box.className = 'rec-box show'
    box.textContent = '正在识别录音…（首次会加载模型，之后会快很多）'
    try {
      await flushSave()
      if (!await window.settingsAPI.testRecognize()) throw new Error('无法启动识别，请重试')
    } catch (err) {
      recognizing = false
      syncAudioControls()
      box.textContent = '识别失败：' + err.message
    }
  })

  $('btnPlayRecording').addEventListener('click', () => playRecording())

  /* ---- 位置快捷操作 ---- */

  $('btnCenterX').addEventListener('click', () => {
    $('anchorX').value = 50
    $('anchorXOut').textContent = '50%'
    scheduleSave({ anchorX: 0.5 })
  })

  $('btnUnlock').addEventListener('click', async () => {
    await window.settingsAPI.setClickThrough(false)
    refreshStatus()
  })

  /* ---- 引擎 ---- */

  $('asrEngine').addEventListener('change', () => {
    if (syncing) return
    const engine = $('asrEngine').value
    scheduleSave({ asr: { engine } })
    syncEngineBlocks()
    window.settingsAPI.checkEnv(engine)
  })

  for (const [id, key] of Object.entries(ASR_FIELDS)) {
    const el = $(id)
    el.addEventListener('change', () => {
      if (syncing) return
      let value = el.type === 'checkbox' ? el.checked : el.value
      // 接口超时必须是数字：按 5~120 秒收敛，和配置层保持同一范围
      if (key === 'apiTimeout') {
        const n = Number(value)
        value = Number.isFinite(n) ? Math.min(120, Math.max(5, Math.round(n))) : 30
        el.value = value
      }
      scheduleSave({ asr: { [key]: value } })
    })
  }

  $('btnCheckEnv').addEventListener('click', () => {
    window.settingsAPI.checkEnv($('asrEngine').value)
  })

  $('btnInstall').addEventListener('click', () => {
    window.settingsAPI.runInstall($('asrEngine').value)
  })

  $('btnReloadModel').addEventListener('click', async () => {
    const btn = $('btnReloadModel')
    reloadingEngine = true
    btn.disabled = true
    btn.textContent = '正在重新加载…'
    await window.settingsAPI.reloadEngine()
    setTimeout(async () => {
      reloadingEngine = false
      syncAudioControls()
      btn.textContent = '重新加载模型'
      await refreshStatus()
    }, 1500)
  })

  /* ---- 底部按钮 ---- */

  $('btnToggle').addEventListener('click', async () => {
    await window.settingsAPI.toggleEngine()
    refreshStatus()
  })

  $('btnLock').addEventListener('click', async () => {
    const next = !(cfg && cfg.clickThrough !== false)
    await window.settingsAPI.setClickThrough(next)
    refreshStatus()
  })

  $('btnReset').addEventListener('click', async () => {
    const defaults = await window.settingsAPI.getDefaults()
    cfg = await window.settingsAPI.setConfig(defaults)
    fill(cfg)
    await loadDisplays()
  })

  $('btnQuit').addEventListener('click', () => window.settingsAPI.quit())
}

/* ---------------- 状态展示 ---------------- */

async function refreshStatus () {
  let s
  try {
    s = await window.settingsAPI.getStatus()
  } catch (_) {
    return
  }

  const state = s.engine.state
  const badge = $('engineBadge')
  badge.textContent = STATE_TEXT[state] || state
  badge.className = 'badge ' + (
    state === 'running' ? 'ok'
      : state === 'error' ? 'err'
        : (state === 'starting' || state === 'loading') ? 'warn'
          : ''
  )

  engineRunning = !!s.running
  // 重新打开设置窗时，从主进程接续未完成的诊断状态。
  if (!diagnosticsHydrated) {
    diagnosticsHydrated = true
    recording = !!s.recording
    micTesting = !!s.micTesting
    recognizing = !!s.recognizing
  }
  if (!recording && s.recordingPath) lastRecordingPath = s.recordingPath
  syncAudioControls()
  $('btnToggle').textContent = s.running ? '停止识别' : '开始识别' 
  $('btnLock').textContent = s.clickThrough ? '解锁字幕' : '锁定字幕'

  if (cfg) cfg.clickThrough = s.clickThrough
  $('clickThrough').checked = s.clickThrough

  // 字幕层显隐是运行时状态：托盘热键/右键菜单改过之后，设置窗的开关要跟着走
  overlayVisibleState = s.overlayVisible !== false
  $('overlayVisible').checked = overlayVisibleState

  const detail = s.engine.detail ? ` · ${s.engine.detail}` : ''
  $('metaText').textContent =
    `引擎：${STATE_TEXT[state] || state}${detail} · Python PID：${s.pythonPid ?? '—'} · ${s.mock ? '模拟数据（--mock）' : '真实识别'}`

  if (s.packaged && !capabilitiesApplied) {
    capabilitiesApplied = true
    applyCapabilities(s)
  }
}

/* ---------------- 订阅 ---------------- */

window.settingsAPI.onSubtitle((s) => {
  const box = $('preview')
  if (!s.final && !s.partial) {
    box.textContent = '（等待识别…）'
    return
  }
  box.innerHTML = ''
  if (s.final) box.appendChild(document.createTextNode(s.final))
  if (s.partial) {
    const span = document.createElement('span')
    span.className = 'draft'
    span.textContent = s.partial
    box.appendChild(span)
  }
})

window.settingsAPI.onStatus(() => refreshStatus())

window.settingsAPI.onDisplaysChanged(async () => {
  await loadDisplays()
})

// 托盘菜单 / Ctrl+Alt+H 切换显示状态时，同步设置窗里的开关
window.settingsAPI.onOverlayVisible((v) => {
  overlayVisibleState = v !== false
  $('overlayVisible').checked = overlayVisibleState
})

window.settingsAPI.onAudioDevices((list) => {
  audioDevices = Array.isArray(list) ? list : []
  renderAudioDevices()
})

// 扬声器（电脑声音输出）端点：采集模式为 output 时使用
window.settingsAPI.onAudioOutputDevices((list) => {
  audioOutputDevices = Array.isArray(list) ? list : []
  renderAudioDevices()
})

// 兼容主进程中尚未结束的诊断任务，完成后只解除录音互斥，不再展示独立测试入口。
window.settingsAPI.onMicTest(() => {
  micTesting = false
  syncAudioControls()
})

window.settingsAPI.onRecordResult((r) => {
  diagnosticsHydrated = true
  finishRecordingUi()
  const box = $('recordResult')
  box.className = 'rec-box show'

  if (!r || !r.ok) {
    lastRecordingPath = null
    syncAudioControls()
    box.textContent = '录制失败：' + (r && r.detail ? r.detail : '未知错误')
    return
  }

  lastRecordingPath = r.path || null
  syncAudioControls()

  box.innerHTML = ''

  const fromOutput = r.captureSource === 'output'
  const source = fromOutput
    ? 'Windows 原生 / WASAPI 环回（电脑声音）'
    : 'Windows 原生 / Media Foundation'

  const meta = document.createElement('div')
  meta.className = 'muted'
  meta.textContent = `已录制 ${r.duration}s · ${r.sampleRate}Hz · ${r.channels || 1} 声道 · 峰值 ${r.peak} · ${source}${r.deviceName ? ` · ${r.deviceName}` : ''}`
  box.appendChild(meta)

  const hint = document.createElement('div')
  const hasSignal = (r.rms ?? r.peak) > 0.001
  hint.className = hasSignal ? 'ok' : 'bad'
  hint.textContent = hasSignal
    ? '已采集到声音，可播放试听或识别录音'
    : (fromOutput
        ? '峰值很低，这段录音基本是静音，先确认系统正在播放声音'
        : '峰值很低，这段录音基本是静音，先检查麦克风')
  box.appendChild(hint)

  if (r.discontinuities > 0 || r.streamTicks > 0) {
    const warning = document.createElement('div')
    warning.className = 'bad'
    warning.textContent = `⚠ 原生采集报告不连续 ${r.discontinuities || 0} 次、流间隔 ${r.streamTicks || 0} 次，需试听确认是否掉音`
    box.appendChild(warning)
  }
  if (r.overflows > 0) {
    const warning = document.createElement('div')
    warning.className = 'bad'
    warning.textContent = `⚠ 采集缓冲溢出 ${r.overflows} 次，音频可能掉音，请关闭其他占用麦克风或高负载程序后重试`
    box.appendChild(warning)
  }
  if (r.clipped && r.clipped > 0.1) {
    const clip = document.createElement('div')
    clip.className = 'bad'
    clip.textContent = fromOutput
      ? `⚠ 有 ${r.clipped}% 的样本削顶，声音可能失真（播放音量偏高）`
      : `⚠ 有 ${r.clipped}% 的样本削顶，声音可能失真（麦克风电平偏高）`
    box.appendChild(clip)
  }
})

window.settingsAPI.onRecordLevel((r) => {
  if (!r || !recording || recordStopping) return
  $('recordResult').textContent = currentCaptureKind() === 'output'
    ? '正在录制电脑声音，请让扬声器播放声音…（再点一次可提前停止）'
    : '正在录制，请对着麦克风说话…（再点一次可提前停止）'
  const fill = $('recordMeterFill')
  const text = $('recordMeterText')
  if (!fill || !text) return

  const pct = Math.min(100, Math.max(2, r.level * 400))
  fill.style.width = pct + '%'
  fill.style.background = r.level > 0.01
    ? 'linear-gradient(90deg,#2dd4bf,#5eead4)'
    : '#475569'
  text.textContent =
    `${r.elapsed.toFixed(1)} / ${r.duration.toFixed(1)}s · 电平 ${r.level}`
})

window.settingsAPI.onRecognizeResult((r) => {
  diagnosticsHydrated = true
  recognizing = false
  syncAudioControls()
  const box = $('recordResult')
  box.className = 'rec-box show'

  if (!r || !r.ok) {
    box.textContent = '识别失败：' + (r && r.detail ? r.detail : '未知错误')
    return
  }

  box.innerHTML = ''

  const textLine = document.createElement('div')
  textLine.className = r.text ? 'ok' : 'bad'
  textLine.textContent = r.text ? `识别结果：${r.text}` : '识别结果：（空）'
  box.appendChild(textLine)

  const timing = document.createElement('div')
  timing.className = 'muted'
  timing.textContent =
    `音频 ${r.duration}s · 模型加载 ${r.loadSeconds}s · 推理 ${r.inferSeconds}s`
  box.appendChild(timing)
})

window.settingsAPI.onEnvState((state) => {
  renderEnv(state)
})

window.settingsAPI.onInstallProgress((p) => {
  if (!p) return
  if (p.phase === 'start') {
    installLines = []
    appendInstallLog(`开始安装引擎：${p.engine}`)
    $('btnInstall').disabled = true
  } else if (p.phase === 'log') {
    appendInstallLog(p.message)
  } else if (p.phase === 'done') {
    appendInstallLog(p.ok ? '安装完成' : '安装失败，请查看上面的日志')
    $('btnInstall').disabled = false
  }
})

window.settingsAPI.onConfig(async (c) => {
  cfg = c
  const active = document.activeElement
  if (active && (active.type === 'range' || active.type === 'text' || active.type === 'number')) {
    // 正在拖动/输入，不要回填打断
    $('clickThrough').checked = c.clickThrough !== false
    return
  }
  fill(c)
  await loadDisplays()
})

window.addEventListener('beforeunload', stopRecordingPlayback)

/* ---------------- 启动 ---------------- */

;(async () => {
  cfg = await window.settingsAPI.getConfig()
  fill(cfg)
  bindAll()
  await loadDisplays()
  await refreshStatus()

  window.settingsAPI.getAudioDevices()
  window.settingsAPI.checkEnv(cfg.asr.engine || 'funasr')

  setInterval(refreshStatus, 1000)
})()
