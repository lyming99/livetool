import type { ReactNode } from 'react'
import type { PanelProps } from './panels'
import { NumberField, SelectField, Switch } from './fields'

/**
 * 语音 + 字幕录制。
 *
 * 录制由 Python 侧在实时识别时同步落盘：真实音频按片段写成 WAV，
 * 定稿字幕写成标准字幕文件（SRT / VTT），目录名带开始日期时间。
 */
export function RecordingPanel({ config, model, state }: PanelProps): ReactNode {
  const asr = config.asr
  const session = state.status.session
  const running = state.status.running
  const directory = asr.recordDir.trim()
  const format = asr.recordSubtitleFormat.toUpperCase()
  const shown = session.directory || (directory || '默认目录（应用数据目录下的 recordings）')
  return <section className="card"><h2>语音与字幕录制</h2>
    <Switch id="recordEnabled" label="识别时同时录制真实语音与字幕" checked={asr.recordEnabled} onChange={recordEnabled => model.edit({ asr: { recordEnabled } })} />
    <div className="hint-line" id="recordHint">{asr.recordEnabled
      ? `开始识别时会新建一个以日期时间命名的会话目录，音频按 ${asr.recordSegmentSeconds} 秒切片段，字幕保存为 ${format}。识别过程中开关改动即刻生效：打开会从当前时刻新建会话，关闭会收尾保存。`
      : '开启后每次实时识别都会把真实音频和定稿字幕保存到指定文件夹；关闭时只显示字幕、不写文件。'}</div>
    <div className="field"><label htmlFor="recordDir">存放文件夹</label>
      <input id="recordDir" type="text" readOnly value={directory} placeholder="默认：应用数据目录下的 recordings" title={shown} />
      <button id="btnChooseRecordDir" className="mini" onClick={() => void model.run(() => model.chooseRecordDir())}>选择…</button></div>
    <div className="row-actions">
      <button id="btnOpenRecordDir" className="mini" onClick={() => void model.run(() => model.openRecordDir())}>打开文件夹</button>
      {directory && <button id="btnResetRecordDir" className="mini" onClick={() => model.edit({ asr: { recordDir: '' } })}>恢复默认目录</button>}
    </div>
    <NumberField id="recordSegmentSeconds" label="片段时长" value={asr.recordSegmentSeconds} min={30} max={3600} step={30} unit="秒" disabled={!asr.recordEnabled} onChange={recordSegmentSeconds => model.edit({ asr: { recordSegmentSeconds } })} />
    <div className="hint-line" id="recordSegmentHint">每段音频单独存一个 WAV 文件（16kHz / 单声道 / 16bit），片段文件名带开始时间。</div>
    <SelectField id="recordSubtitleFormat" label="字幕格式" value={asr.recordSubtitleFormat} disabled={!asr.recordEnabled} options={[['srt', 'SRT（最常见的字幕格式）'], ['vtt', 'WebVTT（网页播放器）']]} onChange={value => model.edit({ asr: { recordSubtitleFormat: value as 'srt' | 'vtt' } })} />
    <div className={'rec-box' + (session.detail || session.directory ? ' show' : '')} id="recordSessionBox">
      {session.detail && <div className={session.active ? 'ok' : 'muted'}>{session.detail}</div>}
      {session.directory && <div className="muted">{running && session.active ? '正在录制' : '已保存'} · 片段 {session.segments} 个 · 字幕 {session.cues} 条 · 时长 {session.durationSeconds.toFixed(1)}s</div>}
      {session.subtitlePath && <div className="muted">字幕文件：{session.subtitlePath}</div>}
    </div>
    <div className="hint-line" id="recordSessionHint">{!asr.recordEnabled ? '未开启录制。' : running ? (session.active ? '正在录制中，停止识别后会收尾保存。' : '正在等待录制会话就绪…') : '录制只在实时识别期间进行；停止识别后文件立即完成写入。'}</div>
  </section>
}
