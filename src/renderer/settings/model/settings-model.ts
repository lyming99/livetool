import type { AppConfig, ConfigPatch, Engine } from '../../../shared/config'
import type { AppStatus, AudioDevice, CaptureSwitch, DisplayInfo, EnvironmentState, SettingsAPI, SubtitleState, Unsubscribe } from '../../../shared/contracts'
import { ConfigWriter } from './config-writer'
import { DiagnosticsController, type DiagnosticState } from './diagnostics'

export const STATE_TEXT: Record<string, string> = { idle: '未启动', starting: '加载中', loading: '加载中', ready: '就绪', running: '识别中', stopping: '正在停止', stopped: '已停止', error: '出错' }
const initialStatus = (): AppStatus => ({ running: false, recording: false, micTesting: false, recognizing: false, recordingPath: null, referenceAvailable: false, clickThrough: true, overlayVisible: true, engine: { state: 'idle', detail: '' }, pythonPid: null, mock: false, packaged: false })
export interface SettingsSnapshot {
  config: AppConfig | null; status: AppStatus; devices: AudioDevice[]; outputs: AudioDevice[]; displays: DisplayInfo[];
  subtitle: SubtitleState; diagnostics: DiagnosticState; environment: EnvironmentState | null;
  installLines: string[]; installing: boolean; reloading: boolean; refreshing: boolean;
  captureHint: string; previewHint: string; displayHint: string; error: string
}

/** Renderer application model: lifecycle subscriptions and business actions, never DOM manipulation. */
export class SettingsModel {
  readonly writer: ConfigWriter
  readonly diagnostics: DiagnosticsController
  private listeners = new Set<() => void>()
  private status = initialStatus()
  private devices: AudioDevice[] = []
  private outputs: AudioDevice[] = []
  private displays: DisplayInfo[] = []
  private subtitle: SubtitleState = { final: '', partial: '' }
  private environment: EnvironmentState | null = null
  private installLines: string[] = []
  private installing = false
  private reloading = false
  private refreshing = false
  private captureHint = ''
  private previewHint = '预览文字只画在字幕层，不写入配置、不影响识别结果；调字号、颜色、位置时用它即时看效果。'
  private displayHint = '字幕窗会铺满所选显示器的可用区域（不含任务栏）。系统改过分辨率或缩放率后，点「刷新」重新贴合字幕层。'
  private error = ''
  private connection = 0
  private statusRevision = 0
  private snapshot!: SettingsSnapshot
  constructor(readonly api: SettingsAPI) {
    this.writer = new ConfigWriter(patch => api.setConfig(patch), this.changed, this.fail)
    this.diagnostics = new DiagnosticsController(api, () => this.writer.flush(), () => this.writer.value?.asr.captureSource === 'output', () => this.status.running, this.changed)
    this.changed()
  }
  private changed = (): void => {
    this.snapshot = {
      config: this.writer?.value ?? null, status: this.status, devices: this.devices, outputs: this.outputs,
      displays: this.displays, subtitle: this.subtitle, diagnostics: this.diagnostics?.state,
      environment: this.environment, installLines: this.installLines, installing: this.installing,
      reloading: this.reloading, refreshing: this.refreshing, captureHint: this.captureHint,
      previewHint: this.previewHint, displayHint: this.displayHint, error: this.error
    }
    for (const listener of this.listeners) listener()
  }
  private fail = (error: unknown): void => { this.error = error instanceof Error ? error.message : String(error); this.changed() }
  subscribe = (listener: () => void): Unsubscribe => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  getSnapshot = (): SettingsSnapshot => this.snapshot
  async run(action: () => Promise<unknown>): Promise<void> {
    this.error = ''; this.changed()
    try { await action() } catch (error) { this.fail(error) }
  }
  edit(patch: ConfigPatch): void { this.writer.edit(patch) }

  connect(): Unsubscribe {
    const connection = ++this.connection
    const current = (): boolean => connection === this.connection
    const keep = <T>(callback: (value: T) => void) => (value: T): void => { if (current()) callback(value) }
    const subscriptions = [
      this.api.onConfig(keep(value => this.writer.accept(value))),
      this.api.onSubtitle(keep(value => { this.subtitle = value; this.changed() })),
      this.api.onStatus(keep(value => {
        this.statusRevision++
        const running = ['starting', 'loading', 'running'].includes(value.state) ? true : ['idle', 'stopped'].includes(value.state) ? false : this.status.running
        this.status = { ...this.status, running, engine: value }; this.changed()
        void this.refreshStatus().catch(this.fail)
      })),
      this.api.onOverlayVisible(keep(value => { this.status = { ...this.status, overlayVisible: value }; this.changed() })),
      this.api.onDisplaysChanged(keep(value => { this.displays = value; this.changed() })),
      this.api.onAudioDevices(keep(value => { this.devices = value; this.changed() })),
      this.api.onAudioOutputDevices(keep(value => { this.outputs = value; this.changed() })),
      this.api.onCaptureSwitch(keep(value => { this.captureHint = this.describeSwitch(value); this.changed() })),
      this.api.onMicTest(keep(() => this.diagnostics.micFinished())),
      this.api.onRecordResult(keep(value => this.diagnostics.recorded(value))),
      this.api.onRecordLevel(keep(value => this.diagnostics.level(value))),
      this.api.onRecognizeResult(keep(value => this.diagnostics.recognized(value))),
      this.api.onEnvState(keep(value => { this.environment = value; this.changed() })),
      this.api.onInstallProgress(keep(value => {
        if (value.phase === 'start') { this.installing = true; this.installLines = [`开始安装引擎：${value.engine}`] }
        else if (value.phase === 'log' && value.message) this.installLines = [...this.installLines, value.message].slice(-300)
        else if (value.phase === 'done') { this.installing = false; this.installLines = [...this.installLines, value.ok ? '安装完成' : '安装失败，请查看上面的日志'].slice(-300) }
        this.changed()
      }))
    ]
    void (async () => {
      const config = await this.api.getConfig()
      if (!current()) return
      this.writer.accept(config)
      this.displays = await this.api.getDisplays()
      if (!current()) return
      this.changed()
      await this.refreshStatus()
      if (!current()) return
      await this.api.getAudioDevices()
      await this.api.checkEnv(this.writer.value?.asr.engine ?? 'funasr')
    })().catch(error => { if (current()) this.fail(error) })
    const timer = setInterval(() => { void this.refreshStatus().catch(error => { if (current()) this.fail(error) }) }, 1000)
    return () => {
      if (!current()) return
      this.connection++
      clearInterval(timer)
      subscriptions.forEach(unsubscribe => unsubscribe())
      this.diagnostics.playback.stop()
      void this.writer.flush().catch(this.fail)
    }
  }
  async refreshStatus(): Promise<void> {
    const connection = this.connection
    const revision = this.statusRevision
    const diagnosticRevision = this.diagnostics.revision
    const value = await this.api.getStatus()
    if (connection !== this.connection || revision !== this.statusRevision) return
    this.status = value; this.diagnostics.hydrate(value, diagnosticRevision); this.changed()
  }
  private describeSwitch(value: CaptureSwitch): string {
    if (!value.ok) return '切换失败：' + (value.detail || '未知错误')
    const label = value.label || (value.kind === 'output' ? '电脑声音' : '麦克风')
    if (value.applied) return `已实时切换到${label}采集，模型不需要重新加载`
    if (value.switched === false) return `当前已经是${label}来源，无需切换`
    return `${label}来源已保存，${value.detail || '下次开始识别时生效'}`
  }
  async toggle(): Promise<void> { await this.writer.flush(); await this.api.toggleEngine(); await this.refreshStatus() }
  async reload(): Promise<void> {
    if (this.reloading || this.diagnostics.busy) return
    this.reloading = true; this.changed()
    try { await this.writer.flush(); if (!await this.api.reloadEngine()) throw new Error('当前状态无法重载引擎'); await this.refreshStatus() }
    finally { this.reloading = false; this.changed() }
  }
  async checkEnvironment(engine: Engine): Promise<void> { await this.writer.flush(); await this.api.checkEnv(engine) }
  async install(engine: Engine): Promise<void> { await this.writer.flush(); await this.api.runInstall(engine) }
  async visible(value: boolean): Promise<void> {
    this.status = { ...this.status, overlayVisible: await this.api.setOverlayVisible(value) }; this.changed()
  }
  async lock(value: boolean): Promise<void> {
    const clickThrough = await this.api.setClickThrough(value)
    this.status = { ...this.status, clickThrough }; this.changed()
    await this.refreshStatus()
  }
  async preview(text: string): Promise<void> {
    await this.api.previewText(text)
    this.previewHint = text ? '预览中：字幕层正在显示这段测试文字，点「清除预览」恢复真实识别结果' : '预览已清除，字幕层恢复显示识别结果'
    this.changed()
  }
  async refreshDisplays(): Promise<void> {
    this.refreshing = true; this.changed()
    try {
      await this.writer.flush(); this.displays = await this.api.refreshDisplays()
      this.displayHint = '已重新读取显示器分辨率与缩放率，字幕层已按新尺寸重新贴合'
    } finally { this.refreshing = false; this.changed() }
  }
  async quit(): Promise<void> { await this.writer.flush(); await this.api.quit() }
  async reset(): Promise<void> {
    await this.writer.flush()
    const defaults = await this.api.getDefaults()
    this.writer.edit(defaults); await this.writer.flush()
  }
  dispose(): void { this.connection++; this.writer.dispose(); this.diagnostics.dispose(); this.listeners.clear() }
}
