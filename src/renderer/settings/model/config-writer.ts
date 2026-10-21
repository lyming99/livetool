import { configSchema, mergeConfig, type AppConfig, type ConfigPatch } from '../../../shared/config'

function mergePatch(first: ConfigPatch, second: ConfigPatch): ConfigPatch {
  const result = { ...first, ...second }
  if (first.asr || second.asr) result.asr = { ...first.asr, ...second.asr }
  return result
}
interface SaveTask { patch: ConfigPatch; promise: Promise<void>; resolve(): void; reject(error: unknown): void }

/** Serial writes + optimistic drafts: a delayed config push cannot wipe a newer edit. */
export class ConfigWriter {
  private confirmed: AppConfig | null = null
  private view: AppConfig | null = null
  private pending: ConfigPatch = {}
  private tasks: SaveTask[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private pumping = false
  private disposed = false
  constructor(private readonly save: (patch: ConfigPatch) => Promise<AppConfig>, private readonly changed: () => void, private readonly failed: (error: unknown) => void) {}
  get value(): AppConfig | null {
    if (!this.confirmed) return null
    if (this.view) return this.view
    let value = this.confirmed
    for (const task of this.tasks) value = mergeConfig(value, task.patch)
    this.view = mergeConfig(value, this.pending)
    return this.view
  }
  accept(value: AppConfig): void { this.confirmed = configSchema.parse(value); this.view = null; this.changed() }
  edit(patch: ConfigPatch): void {
    if (this.disposed) return
    this.pending = mergePatch(this.pending, patch)
    this.view = null
    this.changed()
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.flush().catch(this.failed) }, 60)
  }
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (Object.keys(this.pending).length) {
      let resolve!: () => void
      let reject!: (error: unknown) => void
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
      this.tasks.push({ patch: this.pending, promise, resolve, reject })
      this.pending = {}
    }
    const completion = Promise.all(this.tasks.map(task => task.promise)).then(() => undefined)
    if (!this.pumping && this.tasks.length) void this.pump()
    return completion
  }
  private async pump(): Promise<void> {
    this.pumping = true
    while (this.tasks.length) {
      const task = this.tasks[0]
      try {
        const next = configSchema.parse(await this.save(task.patch))
        if (!this.disposed) this.confirmed = next
        this.tasks.shift(); task.resolve()
      } catch (error) {
        // Stop the queue on failure. Keep edits in their original order so a failed old
        // value cannot resurrect over a newer queued value when the user retries.
        const failed = this.tasks.splice(0)
        let retry: ConfigPatch = {}
        for (const item of failed) retry = mergePatch(retry, item.patch)
        this.pending = mergePatch(retry, this.pending)
        failed.forEach(item => item.reject(error))
      }
      this.view = null
      if (!this.disposed) this.changed()
    }
    this.pumping = false
  }
  dispose(): void {
    // Flush the last input before the renderer is torn down; report failures without unhandled rejections.
    void this.flush().catch(this.failed)
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
  }
}
