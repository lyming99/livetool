import type { AppStatus, RecordLevel, RecordResult, RecognizeResult, SettingsAPI } from '../../../shared/contracts'
import { RecordingPlayback } from './playback'

export interface ResultLine { text: string; kind?: 'ok' | 'bad' | 'muted' }
export interface DiagnosticState {
  phase: 'idle' | 'starting' | 'recording' | 'stopping' | 'recognizing';
  micTesting: boolean; path: string | null; lines: ResultLine[]; meter: RecordLevel | null
}
const initial = (): DiagnosticState => ({ phase: 'idle', micTesting: false, path: null, lines: [], meter: null })
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Local pending actions are kept separate from authoritative engine status. */
export class DiagnosticsController {
  state = initial()
  private interacted = false
  private generation = 0
  private disposed = false
  readonly playback: RecordingPlayback
  constructor(private readonly api: SettingsAPI, private readonly flush: () => Promise<void>, private readonly output: () => boolean, private readonly engineRunning: () => boolean, private readonly changed: () => void) {
    this.playback = new RecordingPlayback(api.readRecording)
  }
  private update(patch: Partial<DiagnosticState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }; this.changed()
  }
  get recording(): boolean { return ['starting', 'recording', 'stopping'].includes(this.state.phase) }
  get busy(): boolean { return this.recording || this.state.micTesting || this.state.phase === 'recognizing' }
  get revision(): number { return this.generation }
  hydrate(status: AppStatus, expectedRevision = this.generation): void {
    if (expectedRevision !== this.generation) return
    if (!this.interacted) {
      this.interacted = true
      this.update({ phase: status.recording ? 'recording' : status.recognizing ? 'recognizing' : 'idle', micTesting: status.micTesting, path: status.recordingPath })
    } else if (!this.busy && status.recordingPath && status.recordingPath !== this.state.path) this.update({ path: status.recordingPath })
  }
  async record(): Promise<void> {
    if (this.state.phase === 'starting' || this.state.phase === 'stopping') return
    if (this.state.phase === 'recording') {
      const generation = this.generation
      this.update({ phase: 'stopping', lines: [{ text: '正在停止录制并保存…' }] })
      try { if (!await this.api.testRecord(0)) throw new Error('录音已结束，请重新录制') }
      catch (error) { if (generation === this.generation) this.update({ phase: 'idle', meter: null, lines: [{ text: errorText(error), kind: 'bad' }] }) }
      return
    }
    if (this.busy || this.engineRunning()) return
    this.playback.stop()
    this.interacted = true
    const generation = ++this.generation
    this.update({ phase: 'starting', path: null, meter: null, lines: [{ text: this.output() ? '正在准备录制电脑声音，请稍候…（显示「正在录制」后播放声音）' : '正在准备录音，请稍候…（显示「正在录制」后再说话）' }] })
    try {
      await this.flush()
      if (this.disposed || generation !== this.generation) return
      if (!await this.api.testRecord(5)) throw new Error('无法启动录音，请重试')
      if (generation === this.generation && (this.state as DiagnosticState).phase === 'starting') this.update({ phase: 'recording' })
    } catch (error) {
      if (generation === this.generation) this.update({ phase: 'idle', meter: null, lines: [{ text: '录制失败：' + errorText(error), kind: 'bad' }] })
    }
  }
  level(value: RecordLevel): void {
    if (!this.recording || this.state.phase === 'stopping') return
    this.update({ phase: 'recording', meter: value, lines: [{ text: this.output() ? '正在录制电脑声音，请让扬声器播放声音…（再点一次可提前停止）' : '正在录制，请对着麦克风说话…（再点一次可提前停止）' }] })
  }
  recorded(result: RecordResult): void {
    this.interacted = true; this.generation++
    if (!result.ok) { this.update({ phase: 'idle', path: null, meter: null, lines: [{ text: '录制失败：' + (result.detail || '未知错误'), kind: 'bad' }] }); return }
    const output = result.captureSource === 'output'
    const signal = (result.rms ?? result.peak ?? 0) > 0.001
    const source = output ? 'Windows 原生 / WASAPI 环回（电脑声音）' : 'Windows 原生 / Media Foundation'
    const lines: ResultLine[] = [
      { kind: 'muted', text: `已录制 ${result.duration}s · ${result.sampleRate}Hz · ${result.channels || 1} 声道 · 峰值 ${result.peak} · ${source}${result.deviceName ? ' · ' + result.deviceName : ''}` },
      { kind: signal ? 'ok' : 'bad', text: signal ? '已采集到声音，可播放试听或识别录音' : output ? '峰值很低，这段录音基本是静音，先确认系统正在播放声音' : '峰值很低，这段录音基本是静音，先检查麦克风' }
    ]
    if ((result.discontinuities ?? 0) > 0 || (result.streamTicks ?? 0) > 0) lines.push({ kind: 'bad', text: `⚠ 原生采集报告不连续 ${result.discontinuities || 0} 次、流间隔 ${result.streamTicks || 0} 次，需试听确认是否掉音` })
    if ((result.overflows ?? 0) > 0) lines.push({ kind: 'bad', text: `⚠ 采集缓冲溢出 ${result.overflows} 次，音频可能掉音，请关闭其他占用麦克风或高负载程序后重试` })
    if ((result.clipped ?? 0) > 0.1) lines.push({ kind: 'bad', text: `⚠ 有 ${result.clipped}% 的样本削顶，声音可能失真（${output ? '播放音量偏高' : '麦克风电平偏高'}）` })
    this.update({ phase: 'idle', path: result.path || null, meter: null, lines })
  }
  async recognize(): Promise<void> {
    if (this.busy || !this.state.path || this.engineRunning()) return
    this.playback.stop(); this.interacted = true
    const generation = ++this.generation
    this.update({ phase: 'recognizing', lines: [{ text: '正在识别录音…（首次会加载模型，之后会快很多）' }] })
    try {
      await this.flush()
      if (generation !== this.generation || this.disposed) return
      if (!await this.api.testRecognize()) throw new Error('无法启动识别，请重试')
    } catch (error) { if (generation === this.generation) this.update({ phase: 'idle', lines: [{ text: '识别失败：' + errorText(error), kind: 'bad' }] }) }
  }
  recognized(result: RecognizeResult): void {
    this.interacted = true; this.generation++
    const lines: ResultLine[] = result.ok ? [
      { kind: result.text ? 'ok' : 'bad', text: result.text ? '识别结果：' + result.text : '识别结果：（空）' },
      { kind: 'muted', text: `音频 ${result.duration}s · 模型加载 ${result.loadSeconds}s · 推理 ${result.inferSeconds}s` }
    ] : [{ kind: 'bad', text: '识别失败：' + (result.detail || '未知错误') }]
    this.update({ phase: 'idle', lines })
  }
  micFinished(): void { this.update({ micTesting: false }) }
  async play(): Promise<void> {
    if (this.busy || !this.state.path) return
    try { await this.playback.play() } catch (error) { this.update({ lines: [{ text: '播放失败：' + errorText(error), kind: 'bad' }] }) }
  }
  dispose(): void { this.disposed = true; this.generation++; this.playback.stop() }
}
