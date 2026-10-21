import type { ReactNode } from 'react'
import type { PanelProps } from './panels'

export function AudioPanel({ config, model, state }: PanelProps): ReactNode {
  const output = config.asr.captureSource === 'output'
  const catalog = output ? state.outputs : state.devices
  const device = output ? config.asr.audioOutputDevice : config.asr.audioDevice
  const defaultDevice = catalog.find(item => item.default)
  const diagnostic = state.diagnostics
  const recording = model.diagnostics.recording
  const recognizing = diagnostic.phase === 'recognizing'
  const starting = diagnostic.phase === 'starting'
  const stopping = diagnostic.phase === 'stopping'
  const captureBusy = recording || diagnostic.micTesting
  const meter = diagnostic.meter
  const percent = meter ? Math.min(100, Math.max(2, meter.level * 400)) : 2
  const migrated = output ? config.asr.audioOutputDeviceMigrated : config.asr.audioDeviceMigrated
  const hint = !catalog.length ? output ? '未检测到扬声器，请检查系统是否已连接输出设备' : '未检测到原生麦克风，请检查设备、系统权限和原生采集组件' : `检测到 ${catalog.length} 个${output ? '扬声器（电脑声音输出）' : '原生麦克风'}${migrated ? ' · 已保存的设备不可用，请重新选择' : ''}`
  return <section className="card"><h2>音频输入</h2>
    <div className="field"><label htmlFor="captureSource">采集模式</label><select id="captureSource" value={config.asr.captureSource} disabled={captureBusy} onChange={event => model.edit({ asr: { captureSource: event.target.value as 'input' | 'output' } })}><option value="input">麦克风</option><option value="output">电脑声音输出</option></select></div>
    <div className="field"><label htmlFor="audioDevice" id="audioDeviceLabel">{output ? '扬声器' : '麦克风'}</label><select id="audioDevice" disabled={captureBusy} value={device ?? 'default'} onChange={event => {
      const value = event.target.value === 'default' ? null : event.target.value
      model.edit({ asr: output ? { audioOutputDevice: value } : { audioDevice: value } })
    }}><option value="default">{defaultDevice ? `系统默认（${defaultDevice.name}）` : '系统默认'}</option>
      {catalog.map(item => <option value={item.id} key={item.id} title={item.api || ''}>{item.name}</option>)}
      {device !== null && !catalog.some(item => item.id === device) && <option value={device} disabled>已保存的{output ? '扬声器' : '麦克风'}不可用，请刷新或重新选择</option>}
    </select><button id="btnRefreshDevices" className="mini" disabled={captureBusy} onClick={() => void model.run(() => model.api.getAudioDevices())}>刷新</button></div>
    <div className="hint-line" id="captureSourceHint">{output ? '电脑声音输出：采集所选扬声器正在播放的声音（游戏、播放器、会议等），与麦克风无关。' : '麦克风：采集你说话的语音。'}</div>
    <div className="hint-line" id="captureSwitchStatus">{state.captureHint}</div>
    <div className="row-actions">
      <button id="btnRecordTest" className="mini" disabled={starting || stopping || diagnostic.micTesting || recognizing || state.status.running} title={state.status.running ? output ? '请先停止实时识别，再录制电脑声音' : '请先停止实时识别，再录制测试音频' : output ? '录制所选扬声器正在播放的声音' : ''} onClick={() => void model.run(() => model.diagnostics.record())}>{starting ? '正在启动…' : stopping ? '正在停止…' : recording ? '停止录制' : '录制 5 秒'}</button>
      <button id="btnRecognizeTest" className="mini" disabled={model.diagnostics.busy || state.status.running || !diagnostic.path} onClick={() => void model.run(() => model.diagnostics.recognize())}>识别录音</button>
      <button id="btnPlayRecording" className="mini" disabled={model.diagnostics.busy || !diagnostic.path} onClick={() => void model.run(() => model.diagnostics.play())}>播放录音</button>
    </div>
    <div className={'rec-meter' + (recording ? ' show' : '')} id="recordMeter"><div className="rec-meter-fill" id="recordMeterFill" style={{ width: percent + '%', background: meter && meter.level > 0.01 ? 'linear-gradient(90deg,#2dd4bf,#5eead4)' : '#475569' }} /><span className="rec-meter-text" id="recordMeterText">{meter ? `${meter.elapsed.toFixed(1)} / ${meter.duration.toFixed(1)}s · 电平 ${meter.level}` : output ? '正在打开扬声器…' : '正在打开麦克风…'}</span></div>
    <div className={'rec-box' + (diagnostic.lines.length ? ' show' : '')} id="recordResult">{diagnostic.lines.map((line, index) => <div className={line.kind} key={index}>{line.text}</div>)}</div>
    <div className="hint-line" id="audioHint">{hint}</div>
  </section>
}
