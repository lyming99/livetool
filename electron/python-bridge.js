'use strict'

const { spawn } = require('child_process')
const path = require('path')
const readline = require('readline')
const { EventEmitter } = require('events')

/**
 * Python sidecar 桥接。
 *
 * 协议：stdin / stdout 各一行一个 JSON（JSON Lines）。
 *   子进程 -> 主进程: {"type":"partial"|"final"|"status"|"error"|"log", ...}
 *   主进程 -> 子进程: {"type":"start"|"stop"|"shutdown"|"config", ...}
 *
 * 用管道而不是 WebSocket：字幕每秒只有几条消息，省掉端口占用、
 * 防火墙弹窗和断线重连。stderr 单独收集为日志，不参与协议。
 */
class PythonBridge extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.proc = null
    this.rl = null
    // 打包后直接跑 PyInstaller 产出的 exe，不需要 Python 解释器和脚本路径
    this.pythonPath = opts.pythonPath || process.env.LIVETOOL_PYTHON || 'python'
    this.script = opts.script === undefined
      ? path.join(__dirname, '..', 'backend', 'main.py')
      : opts.script
    // 打包后 __dirname/.. 是 app.asar 文件而不是目录，不能拿来当工作目录
    this.cwd = opts.cwd || path.join(__dirname, '..')
    this.useMock = !!opts.mock
    this.stopping = false
    this.restartTimer = null
  }

  get pid () {
    return this.proc ? this.proc.pid : null
  }

  start () {
    if (this.proc) return
    this.stopping = false

    const args = []
    if (this.script) args.push(this.script)
    if (this.useMock) args.push('--mock')

    const env = {
      ...process.env,
      // Windows 下 Python 默认用 GBK 写 stdout，中文会炸；必须强制 UTF-8
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1'
    }

    this.proc = spawn(this.pythonPath, args, {
      cwd: this.cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    this.rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity })
    this.rl.on('line', (line) => {
      const text = line.trim()
      if (!text) return
      let msg
      try {
        msg = JSON.parse(text)
      } catch (_) {
        this.emit('log', text)
        return
      }
      this.emit('message', msg)
    })

    const errRl = readline.createInterface({ input: this.proc.stderr, crlfDelay: Infinity })
    errRl.on('line', (line) => {
      if (line.trim()) this.emit('stderr', line.trim())
    })

    this.proc.on('error', (err) => {
      this.emit('error', err)
    })

    this.proc.on('exit', (code, signal) => {
      this.emit('exit', { code, signal })
      this.proc = null
      this.rl = null
    })
  }

  /** 发一条命令给 Python 侧；返回是否写入成功 */
  send (obj) {
    if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) return false
    try {
      this.proc.stdin.write(JSON.stringify(obj) + '\n')
      return true
    } catch (err) {
      this.emit('error', err)
      return false
    }
  }

  stop () {
    if (!this.proc) return
    this.stopping = true
    this.send({ type: 'shutdown' })
    const proc = this.proc

    // 先礼后兵：1s 内没退就强杀，Windows 上用 taskkill 保证子树一起结束
    setTimeout(() => {
      if (!proc || proc.exitCode !== null) return
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true })
        } else {
          proc.kill('SIGKILL')
        }
      } catch (_) { /* ignore */ }
    }, 1000)
  }
}

module.exports = { PythonBridge }
