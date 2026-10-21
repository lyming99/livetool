import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface, type Interface } from 'node:readline'
import { backendEventSchema, type BackendCommand, type BackendEvent } from '../../shared/contracts'

export interface BridgeOptions { executable: string; script?: string; cwd: string; mock?: boolean }
export interface BridgePort {
  readonly pid: number | null
  start(): void; send(command: BackendCommand): boolean; stop(): void; shutdown?(): Promise<void>
  on(event: string, listener: (...args: any[]) => void): this
  off(event: string, listener: (...args: any[]) => void): this
}

export class PythonBridge extends EventEmitter implements BridgePort {
  private proc: ChildProcessWithoutNullStreams | null = null
  private lines: Interface[] = []
  private killTimer: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly options: BridgeOptions) { super() }
  get pid(): number | null { return this.proc?.pid ?? null }

  start(): void {
    if (this.proc) return
    const args = this.options.script ? [this.options.script] : []
    if (this.options.mock) args.push('--mock')
    const proc = spawn(this.options.executable, args, {
      cwd: this.options.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' }
    })
    this.proc = proc
    const stdout = createInterface({ input: proc.stdout, crlfDelay: Infinity })
    const stderr = createInterface({ input: proc.stderr, crlfDelay: Infinity })
    this.lines = [stdout, stderr]
    stdout.on('line', line => this.acceptLine(line))
    stderr.on('line', line => { if (line.trim()) this.emit('stderr', line.trim()) })
    proc.stdin.on('error', error => this.emit('error', error))
    proc.on('error', error => this.emit('error', error))
    // Failed spawns can emit error + close without exit; always release the port
    // so the next user action can retry instead of keeping a dead bridge cached.
    proc.once('close', (code, signal) => {
      if (this.killTimer) clearTimeout(this.killTimer)
      stdout.close(); stderr.close()
      if (this.proc === proc) { this.proc = null; this.lines = [] }
      this.emit('exit', { code, signal })
    })
  }

  acceptLine(line: string): void {
    if (!line.trim()) return
    let value: unknown
    try { value = JSON.parse(line) } catch { this.emit('log', line); return }
    const parsed = backendEventSchema.safeParse(value)
    if (!parsed.success) { this.emit('log', '[protocol] 已忽略无效后端事件'); return }
    this.emit('message', parsed.data satisfies BackendEvent)
  }

  send(command: BackendCommand): boolean {
    const input = this.proc?.stdin
    if (!input?.writable || input.destroyed || input.writableLength > 256 * 1024) return false
    try { input.write(JSON.stringify(command) + '\n'); return true } catch (error) { this.emit('error', error); return false }
  }

  shutdown(): Promise<void> {
    if (!this.proc) return Promise.resolve()
    return new Promise(resolve => {
      const finish = (): void => { clearTimeout(fallback); this.off('exit', finish); resolve() }
      const fallback = setTimeout(finish, 5000)
      this.once('exit', finish)
      this.stop()
    })
  }

  stop(): void {
    const proc = this.proc
    if (!proc) return
    this.send({ type: 'shutdown' })
    this.killTimer = setTimeout(() => {
      if (proc.exitCode !== null) return
      if (process.platform === 'win32' && proc.pid) {
        const killer = spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true })
        killer.on('error', () => { proc.kill() })
      } else proc.kill('SIGKILL')
    }, 1500)
    this.killTimer.unref()
  }
}
