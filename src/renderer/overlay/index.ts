import type { AppConfig } from '../../shared/config'
import type { SubtitleState } from '../../shared/contracts'

'use strict'

/**
 * 字幕渲染层。
 *
 * 为什么用 Canvas 而不是普通 DOM 文字：
 * CSS 的 -webkit-text-stroke 是「居中描边」，会吃掉一半字形，
 * 中文细笔画会明显发糊。Canvas 可以精确做到先 strokeText 再 fillText，
 * 描边只向外扩，字形完整，和 Qt 的 QPainterPath 是同一套思路。
 */

const canvas = document.getElementById('subtitle') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!

let cfg: AppConfig | null = null
let state: SubtitleState = { final: '', partial: '' }
// 预览测试文字：非空时字幕层只画这段文字，识别结果暂时让位
let preview = ''
let dpr = 1
// 上次量到的窗口尺寸：缩放率变化时 innerWidth/Height 可能不变，靠它判断是否需要重算
let lastWidth = 0
let lastHeight = 0
let drag: { startX:number; startY:number; anchorX:number; offsetY:number; dir:number } | null = null
let autoLockTimer: ReturnType<typeof setTimeout> | undefined

// 解锁后如果一直不操作，自动锁回去，避免全屏透明窗把鼠标一直挡住
const AUTO_LOCK_MS = 30000

/* ---------------- 尺寸与配置 ---------------- */

function resize () {
  dpr = window.devicePixelRatio || 1
  const w = window.innerWidth
  const h = window.innerHeight
  lastWidth = w
  lastHeight = h
  canvas.width = Math.max(1, Math.round(w * dpr))
  canvas.height = Math.max(1, Math.round(h * dpr))
  canvas.style.width = w + 'px'
  canvas.style.height = h + 'px'
  // 改 canvas.width 会重置变换，这里统一重设
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  draw()
}

function applyConfig (c: AppConfig) {
  cfg = c
  document.body.classList.toggle('unlocked', c.clickThrough === false)
  armAutoLock()
  draw()
}

function armAutoLock () {
  clearTimeout(autoLockTimer)
  autoLockTimer = undefined
  if (!cfg || cfg.clickThrough !== false) return
  autoLockTimer = setTimeout(() => {
    window.overlayAPI.setClickThrough(true)
  }, AUTO_LOCK_MS)
}

/* ---------------- 文本排版 ---------------- */

function setFont (size: number) {
  ctx.font = `${cfg!.fontWeight} ${size}px ${cfg!.fontFamily}`
}

/** 按字符折行：中文逐字断，英文会在词中间断，后续可加词典优化 */
function wrap (text: string, maxWidth: number) {
  const lines = []
  let line = ''
  for (const ch of text) {
    if (ch === '\n') {
      lines.push(line)
      line = ''
      continue
    }
    const test = line + ch
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line)
      line = ch
    } else {
      line = test
    }
  }
  if (line) lines.push(line)
  return lines
}

function widest (lines: string[]) {
  let max = 0
  for (const line of lines) {
    const w = ctx.measureText(line).width
    if (w > max) max = w
  }
  return max
}

/* ---------------- 绘制 ---------------- */

function draw () {
  if (!cfg) return
  const config = cfg

  const W = window.innerWidth
  const H = window.innerHeight
  ctx.clearRect(0, 0, W, H)

  const anchor = typeof config.anchorX === 'number' ? config.anchorX : 0.5
  const cx = W * anchor

  // 字幕以锚点为中心展开，宽度同时受配置比例和「离最近屏幕边缘的距离」限制，
  // 否则拖到边上时文字会被裁掉
  const sideRoom = Math.max(60, Math.min(cx, W - cx))
  const maxW = Math.max(120, Math.min(W * config.widthRatio, sideRoom * 2))

  const baseSize = Math.max(8, config.fontSize)

  // 字号自适应：最长一行超宽时整体缩小，最多缩到 60%
  let size = baseSize
  let finalLines: string[] = []
  let partialLines: string[] = []
  setFont(size)

  const relayout = () => {
    if (preview) {
      // 预览时用测试文字代替识别结果，样式/位置/换行效果与正式字幕完全一致
      finalLines = wrap(preview, maxW)
      partialLines = []
      return
    }
    finalLines = state.final ? wrap(state.final, maxW) : []
    partialLines = (config.showPartial && state.partial) ? wrap(state.partial, maxW) : []
  }
  relayout()

  for (let guard = 0; guard < 10; guard++) {
    const w = Math.max(widest(finalLines), widest(partialLines))
    if (w <= maxW || size <= baseSize * 0.6) break
    size = Math.max(baseSize * 0.6, size * (maxW / w) * 0.98)
    setFont(size)
    relayout()
  }

  const rows = []
  for (const t of finalLines) rows.push({ text: t, draft: false })
  for (const t of partialLines) rows.push({ text: t, draft: true })

  const maxLines = Math.max(1, Math.round(config.maxLines))
  const shown = rows.slice(-maxLines)
  if (!shown.length) return

  const lineH = size * 1.28 + config.lineGap
  const blockH = shown.length * lineH - config.lineGap

  let top
  if (config.position === 'top') {
    top = config.offsetY
  } else {
    top = H - config.offsetY - blockH
  }

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2
  ctx.lineWidth = Math.max(0, config.strokeWidth)
  ctx.strokeStyle = config.strokeColor
  ctx.fillStyle = config.color

  const baseAlpha = typeof config.opacity === 'number' ? config.opacity : 1

  shown.forEach((row, i) => {
    const cy = top + i * lineH + lineH / 2
    // 草稿行半透明，让「还没定稿」这件事一眼可辨
    ctx.globalAlpha = baseAlpha * (row.draft ? 0.62 : 1)
    if (config.strokeWidth > 0) ctx.strokeText(row.text, cx, cy)
    ctx.fillText(row.text, cx, cy)
  })
  ctx.globalAlpha = 1
}

/* ---------------- 交互：解锁后可自由拖动位置 ---------------- */

function clamp (v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

canvas.addEventListener('mousedown', (e) => {
  if (!cfg || cfg.clickThrough !== false) return
  drag = {
    startX: e.clientX,
    startY: e.clientY,
    anchorX: typeof cfg.anchorX === 'number' ? cfg.anchorX : 0.5,
    offsetY: cfg.offsetY,
    // 字幕贴底时，往下拖应该让它更靠近屏幕底部
    dir: cfg.position === 'bottom' ? -1 : 1
  }
  armAutoLock()
})

window.addEventListener('mousemove', (e) => {
  if (!drag || !cfg) return
  const W = window.innerWidth
  const dx = e.clientX - drag.startX
  const dy = e.clientY - drag.startY

  cfg.anchorX = clamp(drag.anchorX + dx / W, 0.05, 0.95)
  cfg.offsetY = Math.max(0, Math.round(drag.offsetY + dy * drag.dir))
  draw()
})

window.addEventListener('mouseup', () => {
  if (!drag || !cfg) return
  drag = null
  window.overlayAPI.setConfig({ anchorX: cfg.anchorX, offsetY: cfg.offsetY })
  armAutoLock()
})

window.addEventListener('dblclick', () => {
  if (cfg && cfg.clickThrough === false) window.overlayAPI.openSettings()
})

/* ---------------- 启动 ---------------- */

window.addEventListener('resize', resize)

const stopSubtitle = window.overlayAPI.onSubtitle((s) => {
  state = { final: s.final || '', partial: s.partial || '' }
  draw()
})

const stopPreview = window.overlayAPI.onPreview((text) => {
  preview = typeof text === 'string' ? text : ''
  draw()
})

// 缩放率变化时 devicePixelRatio 会变但 innerWidth 可能不变，必须显式重新量一次
const stopMetrics = window.overlayAPI.onMetrics(() => {
  const w = window.innerWidth
  const h = window.innerHeight
  const nextDpr = window.devicePixelRatio || 1
  if (w === lastWidth && h === lastHeight && nextDpr === dpr) return
  lastWidth = w
  lastHeight = h
  resize()
})

const stopConfig = window.overlayAPI.onConfig((c) => applyConfig(c))

window.overlayAPI.getConfig().then((c) => {
  applyConfig(c)
  resize()
})

const dispose = (): void => { stopSubtitle(); stopPreview(); stopMetrics(); stopConfig(); clearTimeout(autoLockTimer) }
window.addEventListener("beforeunload", dispose, { once:true })
