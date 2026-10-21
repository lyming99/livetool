import { useState, type ReactNode } from 'react'
import type { AppConfig } from '../../../shared/config'
import type { SettingsModel, SettingsSnapshot } from '../model/settings-model'
import { NumberField, RangeField, SelectField, Switch } from './fields'
export interface PanelProps { config: AppConfig; model: SettingsModel; state: SettingsSnapshot }

export function AppearancePanel({ config, model }: PanelProps): ReactNode {
  return <section className="card"><h2>文字</h2>
    <SelectField id="fontFamily" label="字体" value={config.fontFamily} onChange={fontFamily => model.edit({ fontFamily })} options={[
      ['"Microsoft YaHei UI", "Microsoft YaHei", sans-serif', '微软雅黑'], ['"Source Han Sans SC", "Noto Sans CJK SC", sans-serif', '思源黑体'], ['"SimHei", sans-serif', '黑体'], ['system-ui, sans-serif', '系统默认']
    ]} />
    <SelectField id="fontWeight" label="字重" value={config.fontWeight} onChange={value => model.edit({ fontWeight: Number(value) })} options={[[400, '常规'], [500, '中等'], [700, '粗体'], [900, '特粗']]} />
    <RangeField id="fontSize" label="字号" value={config.fontSize} min={16} max={96} onChange={fontSize => model.edit({ fontSize })} />
    <div className="field"><label htmlFor="color">文字颜色</label><input type="color" id="color" value={config.color} onChange={event => model.edit({ color: event.target.value })} /></div>
    <div className="field"><label htmlFor="strokeColor">描边颜色</label><input type="color" id="strokeColor" value={config.strokeColor} onChange={event => model.edit({ strokeColor: event.target.value })} /></div>
    <RangeField id="strokeWidth" label="描边粗细" value={config.strokeWidth} min={0} max={14} onChange={strokeWidth => model.edit({ strokeWidth })} />
  </section>
}

export function DisplayPanel({ config, model, state }: PanelProps): ReactNode {
  const target = state.displays.find(display => display.id === config.displayId) || state.displays.find(display => display.primary) || state.displays[0]
  const selected = config.displayId === null ? 'primary' : String((state.displays.find(display => display.id === config.displayId) || state.displays.find(display => display.label === config.displayLabel))?.id ?? 'primary')
  const info = target ? `当前字幕屏：${target.label}${target.primary ? '（主屏）' : ''} · 分辨率 ${target.width}×${target.height} · 可用区 ${target.workWidth}×${target.workHeight} · 缩放 ${Math.round(target.scaleFactor * 100)}%${target.rotation ? ' · 旋转 ' + target.rotation + '°' : ''} · 起点 ${target.x},${target.y}` : '未检测到显示器，可点「刷新」重新扫描'
  return <section className="card"><h2>显示器与位置</h2>
    <div className="field"><label htmlFor="displayId">显示器</label><select id="displayId" value={selected} onChange={event => {
      const id = event.target.value === 'primary' ? null : Number(event.target.value)
      model.edit({ displayId: id, displayLabel: state.displays.find(display => display.id === id)?.label ?? null })
    }}><option value="primary">跟随主显示器</option>{state.displays.map(display => <option key={display.id} value={display.id}>{display.label}{display.primary ? '（主屏）' : ''} · {display.width}×{display.height}{display.scaleFactor !== 1 ? ' · 缩放 ' + Math.round(display.scaleFactor * 100) + '%' : ''}</option>)}</select>
    <button id="btnRefreshDisplays" className="mini" title="重新扫描显示器，重新读取分辨率与缩放率" disabled={state.refreshing} onClick={() => void model.run(() => model.refreshDisplays())}>{state.refreshing ? '刷新中…' : '刷新'}</button></div>
    <div className="hint-line" id="displayInfo">{info}</div><div className="hint-line" id="displayHint">{state.displayHint}</div>
    <SelectField id="position" label="垂直位置" value={config.position} options={[[ 'bottom', '贴底' ], [ 'top', '贴顶' ]]} onChange={value => model.edit({ position: value as AppConfig['position'] })} />
    <RangeField id="offsetY" label="垂直偏移" value={config.offsetY} min={0} max={600} step={2} onChange={offsetY => model.edit({ offsetY })} />
    <RangeField id="anchorX" label="水平位置" value={config.anchorX} min={5} max={95} percentage onChange={anchorX => model.edit({ anchorX })} />
    <div className="row-actions"><button id="btnCenterX" className="mini" onClick={() => model.edit({ anchorX: 0.5 })}>水平居中</button><button id="btnUnlock" className="mini" onClick={() => void model.run(() => model.lock(false))}>解锁并拖动</button></div>
    <RangeField id="widthRatio" label="宽度占比" value={config.widthRatio} min={30} max={100} percentage onChange={widthRatio => model.edit({ widthRatio })} />
    <RangeField id="lineGap" label="行间距" value={config.lineGap} min={0} max={40} onChange={lineGap => model.edit({ lineGap })} />
    <RangeField id="maxLines" label="最多行数" value={config.maxLines} min={1} max={4} onChange={maxLines => model.edit({ maxLines })} />
    <RangeField id="opacity" label="不透明度" value={config.opacity} min={30} max={100} percentage onChange={opacity => model.edit({ opacity })} />
  </section>
}

export function BehaviourPanel({ config, model, state }: PanelProps): ReactNode {
  const sentence = config.subtitleMode === 'sentence'
  return <section className="card"><h2>行为</h2>
    <SelectField id="subtitleMode" label="显示方式" value={config.subtitleMode} options={[[ 'realtime', '实时（边识别边显示）' ], [ 'sentence', '整句定稿后显示' ]]} onChange={value => model.edit({ subtitleMode: value as AppConfig['subtitleMode'] })} />
    <div className="hint-line" id="subtitleModeHint">{sentence ? '整句定稿后才出现：屏幕上不会出现半句草稿，只在识别出一整句后显示。' : '实时显示：识别中的草稿行也会先出现（可关闭下方「草稿行」）。'}</div>
    <Switch id="showPartial" label="显示识别中的草稿行（半透明）" checked={config.showPartial} disabled={sentence} onChange={showPartial => model.edit({ showPartial })} />
    <NumberField id="sentenceDelay" label="定稿延时" value={config.sentenceDelay} min={0} max={10000} step={50} unit="毫秒" disabled={!sentence} onChange={sentenceDelay => model.edit({ sentenceDelay })} />
    <div className="hint-line" id="sentenceDelayHint">{!sentence ? '当前是实时显示，定稿延时只在「整句定稿后显示」时生效。' : config.sentenceDelay > 0 ? `整句定稿后会再等 ${config.sentenceDelay} 毫秒才显示；期间若出现新的一句，直接换成新的整句。` : '整句定稿后立即显示，不再额外等待。'}</div>
    <Switch id="clickThrough" label="锁定字幕（鼠标穿透，不挡操作）" checked={state.status.clickThrough} onChange={value => void model.run(() => model.lock(value))} />
    <Switch id="overlayVisible" label="显示字幕（关闭只隐藏字幕层，识别照常进行）" checked={state.status.overlayVisible} onChange={value => void model.run(() => model.visible(value))} />
    <div className="row-actions"><button id="btnShowOverlay" className="mini" onClick={() => void model.run(() => model.visible(true))}>显示字幕层</button><button id="btnHideOverlay" className="mini" onClick={() => void model.run(() => model.visible(false))}>隐藏字幕层</button></div>
    <NumberField id="autoHideDelay" label="自动隐藏" value={config.autoHideDelay} min={0} max={3600} unit="秒" onChange={autoHideDelay => model.edit({ autoHideDelay })} />
    <div className="hint-line" id="autoHideHint">{config.autoHideDelay <= 0 ? '已关闭自动隐藏：字幕层会一直保持显示，直到你手动隐藏' : `没有新字幕内容超过 ${config.autoHideDelay} 秒后自动隐藏字幕层；出现新字幕会重新显示`}</div>
  </section>
}

export function PreviewPanel({ model, state }: PanelProps): ReactNode {
  const [text, setText] = useState('')
  return <section className="card"><h2>预览测试文字</h2>
    <div className="field"><label htmlFor="previewText">测试文字</label><input type="text" id="previewText" placeholder="输入一段文字，实时显示在字幕层" value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void model.run(() => model.preview(text)) }} /></div>
    <div className="row-actions"><button id="btnPreviewApply" className="mini primary" onClick={() => void model.run(() => model.preview(text))}>显示预览</button><button id="btnPreviewClear" className="mini" onClick={() => void model.run(() => model.preview(''))}>清除预览</button></div>
    <div className="hint-line" id="previewHint">{state.previewHint}</div>
  </section>
}
