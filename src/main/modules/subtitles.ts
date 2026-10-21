import type { AppConfig } from '../../shared/config'
import type { SubtitleState } from '../../shared/contracts'

type SubtitleConfig = Pick<AppConfig, 'subtitleMode' | 'sentenceDelay' | 'autoHideDelay'>
interface Callbacks { subtitle(value: SubtitleState): void; visibility(value: boolean): void; preview(text: string): void }

/** Owns subtitle presentation only: no BrowserWindow, filesystem, model, or IPC dependency. */
export class SubtitleController {
  state: SubtitleState = { final: '', partial: '' }
  visible = true
  previewText = ''
  private autoHidden = false
  private hideTimer: ReturnType<typeof setTimeout> | undefined
  private sentenceTimer: ReturnType<typeof setTimeout> | undefined
  private pending: string | null = null
  constructor(private readonly config: () => SubtitleConfig, private readonly events: Callbacks) {}

  partial(text: string): void {
    if (this.config().subtitleMode === 'sentence') return
    this.state = { ...this.state, partial: text }
    this.publish(); this.activity()
  }
  final(text: string): void {
    if (this.config().subtitleMode === 'sentence') { this.schedule(text); return }
    this.state = { final: text, partial: '' }
    this.publish(); this.activity()
  }
  private publish(): void { this.events.subtitle({ ...this.state }) }
  private schedule(text: string): void {
    this.cancelPending()
    this.pending = text
    const apply = (): void => {
      this.sentenceTimer = undefined
      this.state = { final: this.pending ?? '', partial: '' }
      this.pending = null
      this.publish(); this.activity()
    }
    const delay = Math.min(10000, Math.max(0, this.config().sentenceDelay))
    if (delay === 0) apply()
    else this.sentenceTimer = setTimeout(apply, delay)
  }
  cancelPending(): void {
    if (this.sentenceTimer) clearTimeout(this.sentenceTimer)
    this.sentenceTimer = undefined; this.pending = null
  }
  configChanged(previous: SubtitleConfig): void {
    const current = this.config()
    if (current.subtitleMode !== 'sentence') this.cancelPending()
    else {
      if (this.state.partial) { this.state = { ...this.state, partial: '' }; this.publish() }
      if (this.pending !== null && previous.sentenceDelay !== current.sentenceDelay) this.schedule(this.pending)
    }
    this.restartHide()
  }
  setPreview(text: string): string {
    this.previewText = text
    if (text && !this.visible) this.setVisible(true)
    this.events.preview(text)
    this.restartHide()
    return text
  }
  setVisible(visible: boolean, automatic = false): boolean {
    this.visible = visible; this.autoHidden = automatic
    this.events.visibility(visible)
    this.restartHide()
    return visible
  }
  private activity(): void {
    if (this.previewText || !(this.state.final || this.state.partial)) return
    if (this.autoHidden && !this.visible) this.setVisible(true)
    else this.restartHide()
  }
  private restartHide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = undefined
    const seconds = this.config().autoHideDelay
    if (this.previewText || !this.visible || !(this.state.final || this.state.partial) || seconds <= 0) return
    this.hideTimer = setTimeout(() => this.setVisible(false, true), seconds * 1000)
  }
  dispose(): void { this.cancelPending(); if (this.hideTimer) clearTimeout(this.hideTimer) }
}
