import { EventEmitter } from 'node:events'
import type { AppConfig, Engine } from '../../shared/config'
import type { BackendCommand, BackendEvent, EngineStatus } from '../../shared/contracts'
import type { BridgePort } from '../infrastructure/python-bridge'

/** Owns ASR/diagnostic lifecycle. Windows and renderers only consume its snapshots. */
export class SpeechService extends EventEmitter {
  private bridge: BridgePort | null = null
  running = false
  recording = false
  micTesting = false
  recognizing = false
  recordingPath: string | null = null
  status: EngineStatus = { state: 'idle', detail: '' }
  private transition: Promise<boolean> | null = null
  private disposed = false
  constructor(private readonly createBridge: () => BridgePort, private readonly config: () => AppConfig, readonly mock: boolean) { super() }
  get pid(): number | null { return this.bridge?.pid ?? null }
  private update(status: EngineStatus): void { this.status = status; this.emit('engine:status', { ...status }) }

  ensure(): BridgePort {
    if (this.disposed) throw new Error('识别服务已经关闭')
    if (this.bridge) return this.bridge
    const bridge = this.createBridge()
    this.bridge = bridge
    let warmed = false
    bridge.on('message', (message: BackendEvent) => {
      if (this.bridge !== bridge) return
      if (!warmed && message.type === 'status') {
        warmed = true
        bridge.send({ type: 'list_devices' })
        bridge.send({ type: 'check_env', engine: this.config().asr.engine, asr: this.config().asr })
      }
      this.accept(message)
    })
    bridge.on('log', (line: string) => console.log('[python]', line))
    bridge.on('stderr', (line: string) => console.error('[python:stderr]', line))
    bridge.on('error', (error: Error) => {
      this.failDiagnostics('录音进程不可用：' + error.message)
      this.update({ state: 'error', detail: '无法使用 Python 进程：' + error.message })
    })
    bridge.on('exit', () => {
      if (this.bridge !== bridge) return
      this.bridge = null; this.running = false
      this.failDiagnostics('录音进程已退出，请重新录制')
      this.emit('reset-subtitles')
      this.update(this.status.state === 'error' ? this.status : { state: 'stopped', detail: '识别进程已退出' })
    })
    bridge.start()
    return bridge
  }

  accept(message: BackendEvent): void {
    switch (message.type) {
      case 'partial': case 'final': this.emit('subtitle', message); break
      case 'status':
        // Startup warmup is not confirmation that a later start request has stopped.
        if (message.state === 'idle' && this.running) break
        if (message.state === 'stopped') this.running = false
        this.update({ state: message.state, detail: message.detail ?? '' }); break
      case 'error':
        this.running = false
        this.update({ state: 'error', detail: message.message }); break
      case 'devices':
        this.emit('audio:devices', message.inputs); this.emit('audio:output-devices', message.outputs ?? []); break
      case 'record_result':
        this.recording = false
        this.recordingPath = message.ok && typeof message.path === 'string' ? message.path : null
        this.emit('record:result', message); break
      case 'record_level': this.emit('record:level', message); break
      case 'recognize_result': this.recognizing = false; this.emit('recognize:result', message); break
      case 'mic_test': this.micTesting = false; this.emit('mic:test', message); break
      case 'capture_switch': this.emit('audio:capture-switch', message); break
      case 'env': this.emit('env:state', message); break
      case 'install': this.emit('install:progress', message); break
      default: break
    }
  }

  private send(command: BackendCommand): boolean {
    try { return this.ensure().send(command) } catch (error) {
      this.update({ state: 'error', detail: String(error) }); return false
    }
  }
  private get diagnosing(): boolean { return this.recording || this.micTesting || this.recognizing }
  start(): boolean {
    if (this.diagnosing || this.running) return this.running
    if (!this.send({ type: 'start', asr: this.config().asr })) return false
    this.running = true
    this.emit('reset-subtitles')
    this.update({ state: 'starting', detail: '正在加载识别引擎' })
    return true
  }
  async toggle(): Promise<boolean> {
    if (this.transition) return this.transition
    if (!this.running) return this.start()
    this.transition = this.stopConfirmed().then(() => false).finally(() => { this.transition = null })
    return this.transition
  }
  async reload(): Promise<boolean> {
    if (this.diagnosing) return false
    if (this.transition) return this.transition
    this.transition = (async () => { if (this.running) await this.stopConfirmed(); return this.start() })()
      .finally(() => { this.transition = null })
    return this.transition
  }
  private stopConfirmed(): Promise<void> {
    const bridge = this.ensure()
    this.emit('reset-subtitles')
    this.update({ state: 'stopping', detail: '正在停止识别' })
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer); bridge.off('message', message); bridge.off('exit', exited); bridge.off('error', failed)
      }
      const complete = (): void => { cleanup(); this.running = false; resolve() }
      const failed = (error: Error): void => { cleanup(); this.update({ state: 'error', detail: error.message }); reject(error) }
      const message = (value: BackendEvent): void => {
        if (value.type === 'status' && value.state === 'stopped') complete()
        if (value.type === 'error') failed(new Error(value.message))
      }
      const exited = (): void => { cleanup(); reject(new Error('识别进程已退出')) }
      const timer = setTimeout(() => failed(new Error('等待停止确认超时，请重试停止或重启程序')), 15000)
      bridge.on('message', message).on('exit', exited).on('error', failed)
      if (!bridge.send({ type: 'stop' })) failed(new Error('无法发送停止命令'))
    })
  }
  listDevices(): boolean { return this.send({ type: 'list_devices' }) }
  checkEnvironment(engine: Engine): boolean { return this.send({ type: 'check_env', engine, asr: this.config().asr }) }
  install(engine: Engine): boolean { return this.send({ type: 'install', engine, asr: this.config().asr }) }
  switchCapture(): boolean { return this.send({ type: 'switch_capture', asr: this.config().asr }) }
  record(seconds: number): boolean {
    if (seconds === 0) return this.recording && this.send({ type: 'stop_record' })
    if (this.diagnosing || this.running) return false
    this.recording = this.send({ type: 'record_test', seconds, asr: this.config().asr })
    if (this.recording) this.recordingPath = null
    return this.recording
  }
  recognize(): boolean {
    if (this.diagnosing || this.running) return false
    this.recognizing = this.send({ type: 'recognize_test', asr: this.config().asr })
    return this.recognizing
  }
  testMic(): boolean {
    if (this.diagnosing || this.running) return false
    this.micTesting = this.send({ type: 'mic_test', asr: this.config().asr })
    return this.micTesting
  }
  private failDiagnostics(detail: string): void {
    if (this.recording) this.emit('record:result', { ok: false, detail })
    if (this.recognizing) this.emit('recognize:result', { ok: false, detail })
    if (this.micTesting) this.emit('mic:test', { ok: false, detail })
    this.recording = this.recognizing = this.micTesting = false
  }
  dispose(): Promise<void> {
    this.disposed = true
    if (this.bridge?.shutdown) return this.bridge.shutdown()
    this.bridge?.stop()
    return Promise.resolve()
  }
}
