import type { SettingsAPI } from '../../../shared/contracts'

export class RecordingPlayback {
  private generation = 0
  private audio: HTMLAudioElement | null = null
  private url: string | null = null
  constructor(private readonly read: SettingsAPI['readRecording'], private readonly createAudio = (url: string): HTMLAudioElement => new Audio(url)) {}
  stop(): void {
    this.generation++
    if (this.audio) { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); this.audio = null }
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = null
  }
  async play(): Promise<void> {
    this.stop()
    const generation = this.generation
    try {
      const b64 = await this.read('current')
      if (generation !== this.generation) return
      if (!b64) throw new Error('读不到录音文件')
      const binary = atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      this.url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
      const audio = this.createAudio(this.url)
      this.audio = audio
      audio.playbackRate = 1
      audio.addEventListener('ended', () => { if (this.audio === audio) this.stop() }, { once: true })
      await audio.play()
    } catch (error) {
      if (generation !== this.generation) return
      this.stop()
      throw error
    }
  }
}
