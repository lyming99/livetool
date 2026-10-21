import { EventEmitter } from 'node:events'
import type { AppConfig, Engine } from '../../shared/config'
import type { BackendCommand, BackendEvent, EngineStatus, SessionStatus } from '../../shared/contracts'
import type { BridgePort } from '../infrastructure/python-bridge'

// 自动重启策略：60 秒窗口内最多 5 次，退避 0.8s/1.6s/2.4s…（上限 10s）。
// 识别稳定运行超过 60 秒后重新计数，避免长时间直播中偶发故障累积到上限。
const RESTART_WINDOW_MS = 60_000
const RESTART_MAX_ATTEMPTS = 5
const RESTART_BASE_DELAY_MS = 800
const RESTART_MAX_DELAY_MS = 10_000
const STABLE_RUNNING_MS = 60_000

/** Owns ASR/diagnostic lifecycle. Windows and renderers only consume its snapshots. */
export class SpeechService extends EventEmitter {
  private bridge: BridgePort | null = null
  running = false
  recording = false
  micTesting = false
  recognizing = false
  recordingPath: string | null = null
  status: EngineStatus = { state: 'idle', detail: '' }
  session: SessionStatus = { active: false, directory: null, subtitlePath: null, segments: 0, cues: 0, durationSeconds: 0, detail: '' }
  private transition: Promise<boolean> | null = null
  private disposed = false
  /** 用户是否希望识别在运行；意外退出后据此决定是否自动重启。 */
  private desired = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private stableTimer: ReturnType<typeof setTimeout> | null = null
  private exitGuardTimer: ReturnType<typeof setTimeout> | null = null
  private restartAttempts = 0
  private restartWindowStart = 0
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
      this.bridge = null
      if (this.exitGuardTimer) { clearTimeout(this.exitGuardTimer); this.exitGuardTimer = null }
      if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null }
      const wasRunning = this.running
      this.running = false
      this.failDiagnostics('录音进程已退出，请重新录制')
      this.emit('reset-subtitles')
      if (this.disposed) return
      // 用户主动停止（desired=false）不重启；异常退出时后端已先保存录制内容，
      // 这里负责把识别服务自动拉起来并恢复到「正在识别」。
      if (!this.desired) {
        this.update(this.status.state === 'error' ? this.status : { state: 'stopped', detail: '识别进程已退出' })
        return
      }
      this.update({ state: 'restarting', detail: wasRunning ? '识别进程异常退出，正在自动重启' : '识别服务已退出，正在自动重启' })
      this.scheduleRestart()
    })
    bridge.start()
    return bridge
  }

  private cancelRestart(): void {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null }
    if (this.exitGuardTimer) { clearTimeout(this.exitGuardTimer); this.exitGuardTimer = null }
  }

  /** 用户明确停止：取消待执行的自动重启，不再恢复识别。 */
  private stopIntent(): void {
    this.desired = false
    this.cancelRestart()
  }

  /**
   * 后端报错后恢复：先让当前进程退出（后端在退出前已经保存好录制内容），
   * 再由统一的退避逻辑重新拉起。用户没要求运行时只报错、不重启。
   */
  private recover(detail: string): void {
    if (this.disposed) return
    this.failDiagnostics(detail)
    if (!this.desired) { this.update({ state: 'error', detail }); return }
    const bridge = this.bridge
    this.running = false
    this.emit('reset-subtitles')
    const attempt = Math.min(RESTART_MAX_ATTEMPTS, this.restartAttempts + 1)
    const delay = Math.min(RESTART_MAX_DELAY_MS, RESTART_BASE_DELAY_MS * attempt)
    this.update({ state: 'restarting', detail: `${detail} · ${(delay / 1000).toFixed(1)} 秒后自动重启（第 ${attempt} 次）` })
    if (!bridge) { this.scheduleRestart(); return }
    // 正常会由 exit 事件触发重启；进程卡死时用兜底定时器强行走重启流程。
    if (this.exitGuardTimer) clearTimeout(this.exitGuardTimer)
    this.exitGuardTimer = setTimeout(() => {
      this.exitGuardTimer = null
      if (this.disposed || !this.desired || this.bridge !== bridge) return
      this.bridge = null
      this.scheduleRestart()
    }, Math.max(3000, delay + 1500))
    bridge.stop()
  }

  /** 异常退出后的退避重启：60 秒内最多 5 次，避免坏配置导致无限重启。 */
  private scheduleRestart(): void {
    if (this.disposed || !this.desired || this.restartTimer) return
    const now = Date.now()
    if (!this.restartWindowStart || now - this.restartWindowStart > RESTART_WINDOW_MS) {
      this.restartWindowStart = now
      this.restartAttempts = 0
    }
    if (this.restartAttempts >= RESTART_MAX_ATTEMPTS) {
      this.update({ state: 'error', detail: '识别服务连续异常退出，已停止自动重启；请检查日志后手动开始识别' })
      return
    }
    const attempt = ++this.restartAttempts
    const delay = Math.min(RESTART_MAX_DELAY_MS, RESTART_BASE_DELAY_MS * attempt)
    this.update({ state: 'restarting', detail: `识别服务异常退出，${(delay / 1000).toFixed(1)} 秒后自动重启（第 ${attempt} 次）` })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.disposed || !this.desired) return
      // 起不来就继续排队重启，直到次数上限或用户主动停止
      if (!this.start()) this.scheduleRestart()
    }, delay)
  }

  /** 稳定运行一段时间后清零重启计数，直播中偶发故障不会累计到上限。 */
  private markStable(): void {
    if (this.stableTimer) return
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null
      this.restartAttempts = 0
      this.restartWindowStart = 0
    }, STABLE_RUNNING_MS)
  }

  accept(message: BackendEvent): void {
    switch (message.type) {
      case 'partial': case 'final': this.emit('subtitle', message); break
      case 'status':
        // Startup warmup is not confirmation that a later start request has stopped.
        if (message.state === 'idle' && this.running) break
        if (message.state === 'stopped') this.running = false
        // 真正跑起来后才开始计时；跑满 60 秒就清零重启计数
        if (message.state === 'running') this.markStable()
        this.update({ state: message.state, detail: message.detail ?? '' }); break
      case 'error':
        // 后端报错：先让它退出（退出前后端会保存录制内容），再自动重启恢复识别
        this.recover(message.message); break
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
      case 'session':
        // Recording sessions are additive: recognition state is unaffected.
        this.session = {
          active: message.active === true, directory: typeof message.directory === 'string' ? message.directory : null,
          subtitlePath: typeof message.subtitlePath === 'string' ? message.subtitlePath : null,
          segments: Number(message.segments) || 0, cues: Number(message.cues) || 0,
          durationSeconds: Number(message.durationSeconds) || 0, detail: typeof message.detail === 'string' ? message.detail : ''
        }
        this.emit('session', this.session); break
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
    // 用户（或自动恢复）要求运行：记下意图，异常退出后据此重启
    this.desired = true
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    if (!this.send({ type: 'start', asr: this.config().asr })) return false
    this.running = true
    this.emit('reset-subtitles')
    this.update({ state: 'starting', detail: '正在加载识别引擎' })
    return true
  }
  async toggle(): Promise<boolean> {
    if (this.transition) return this.transition
    if (!this.running) return this.start()
    // 主动停止：先取消自动重启意图，避免停止过程中被当成异常退出再拉起来
    this.stopIntent()
    this.transition = this.stopConfirmed().then(() => false).finally(() => { this.transition = null })
    return this.transition
  }
  async reload(): Promise<boolean> {
    if (this.diagnosing) return false
    if (this.transition) return this.transition
    // 重载属于用户主动重启：期间不触发自动重启，成功后 start() 会重新记下意图
    this.stopIntent()
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
  /** 录制开关在识别运行中即时生效；未运行时后端只记住配置，等 start() 再建会话。 */
  setRecord(enabled: boolean): boolean { return this.send({ type: 'set_record', enabled, asr: this.config().asr }) }
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
    this.stopIntent()
    if (this.bridge?.shutdown) return this.bridge.shutdown()
    this.bridge?.stop()
    return Promise.resolve()
  }
}
