'use strict'
// Runs the actual app entry, not a mocked main process. --mock never opens audio devices.
// An ephemeral loopback-only CDP port and isolated userData are used only for this test.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const ROOT = path.join(__dirname, '..')
const packagedArg = process.argv.find(arg => arg.startsWith('--packaged='))
const dev = process.argv.includes('--dev')
const executable = packagedArg ? path.resolve(ROOT, packagedArg.slice('--packaged='.length)) : require('electron')
const temp = fs.mkdtempSync(path.join(ROOT, 'build', 'app-smoke-'))
fs.writeFileSync(path.join(temp, 'config.json'), '{invalid') // startup must recover without recursive logging
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let child
let connections = []
let output = ''
async function freePort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
class Debugger {
  constructor(socket) {
    this.socket = socket; this.id = 0; this.pending = new Map()
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (!message.id) return
      const task = this.pending.get(message.id)
      if (!task) return
      this.pending.delete(message.id)
      if (message.error) task.reject(new Error(message.error.message))
      else task.resolve(message.result)
    })
    socket.addEventListener('close', () => { for (const task of this.pending.values()) task.reject(new Error('debug target closed')); this.pending.clear() })
  }
  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    return new Debugger(socket)
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => { const id = ++this.id; this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })) })
  }
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result.value
  }
  close() { this.socket.close() }
}
async function waitFor(action, description, timeout = 30000) {
  const deadline = Date.now() + timeout
  let failure
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error('App exited early: ' + output)
    try { const result = await action(); if (result) return result } catch (error) { failure = error }
    await pause(100)
  }
  throw new Error('Timeout: ' + description + (failure ? '\n' + failure.message : '') + '\n' + output.slice(-6000))
}
async function launch() {
  const port = await freePort()
  const flags = ['--mock', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port]
  const command = dev ? process.execPath : executable
  const args = dev ? [path.join(ROOT, 'node_modules/electron-vite/bin/electron-vite.js'), 'dev', '--', ...flags] : packagedArg ? flags : [ROOT, ...flags]
  child = spawn(command, args, { cwd: ROOT, env: { ...process.env, APPDATA: path.join(temp, 'appdata'), LIVETOOL_TEST_USER_DATA: temp }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', bytes => { output += bytes.toString() })
  child.stderr.on('data', bytes => { output += bytes.toString() })
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    const list = await response.json()
    return list.some(target => target.url.includes('settings.html')) && list.some(target => target.url.includes('overlay.html')) ? list : null
  }, 'both application windows')
  if (dev) assert.match(targets.find(target => target.url.includes('settings.html')).url, /^http:\/\//, 'dev smoke must use the Vite server, not stale built HTML')
  const settings = await Debugger.connect(targets.find(target => target.url.includes('settings.html')).webSocketDebuggerUrl)
  const overlay = await Debugger.connect(targets.find(target => target.url.includes('overlay.html')).webSocketDebuggerUrl)
  connections.push(settings, overlay)
  await waitFor(() => settings.evaluate("!!document.getElementById('captureSource') && !!window.settingsAPI"), 'React settings mounted')
  return { settings, overlay }
}
async function quit(settings) {
  const processToWait = child
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('App did not quit gracefully')), 12000)
    processToWait.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('App exit code ' + code)) })
  })
  await settings.evaluate('window.settingsAPI.quit()').catch(() => {})
  await exited
  for (const connection of connections.splice(0)) connection.close()
  child = null
}
async function main() {
  let { settings, overlay } = await launch()
  let current = await waitFor(() => settings.evaluate('window.settingsAPI.getStatus().then(s => s.pythonPid ? s : null)'), 'Python sidecar startup')
  assert.equal(current.mock, true); assert.equal(current.packaged, !!packagedArg)
  const backendPid = current.pythonPid
  await settings.evaluate("window.settingsAPI.setConfig({fontSize:48,asr:{apiKey:'framework-synthetic-key'}})")
  const saved = fs.readFileSync(path.join(temp, 'config.json'), 'utf8')
  assert.ok(!saved.includes('framework-synthetic-key')); assert.ok(JSON.parse(saved).asr.apiKeyEncrypted)
  assert.equal(await overlay.evaluate('window.overlayAPI.getConfig().then(c => c.asr.apiKey)'), '')
  assert.equal(await overlay.evaluate("window.overlayAPI.setConfig({asr:{apiKey:'not-allowed'}}).then(() => false, () => true)"), true)
  await settings.evaluate('window.settingsAPI.toggleEngine()')
  await waitFor(() => settings.evaluate("window.settingsAPI.getStatus().then(s => s.engine.state === 'running')"), 'mock engine running')
  await waitFor(() => settings.evaluate("document.getElementById('preview').textContent !== '（等待识别…）'"), 'live subtitle IPC')
  assert.ok(await overlay.evaluate("document.getElementById('subtitle').width > 0"))
  await settings.evaluate('window.settingsAPI.reloadEngine()')
  await waitFor(() => settings.evaluate("window.settingsAPI.getStatus().then(s => s.engine.state === 'running')"), 'confirmed reload')
  await settings.evaluate('window.settingsAPI.setOverlayVisible(false)')
  await pause(150)
  assert.equal(await settings.evaluate('window.settingsAPI.getStatus().then(s => s.overlayVisible)'), false)
  await settings.evaluate('window.settingsAPI.toggleEngine()')
  assert.equal(await settings.evaluate('window.settingsAPI.getStatus().then(s => s.engine.state)'), 'stopped')
  await quit(settings)
  await pause(100)
  assert.throws(() => process.kill(backendPid, 0), 'Python process must exit with the app')
  if (!dev) {
    ;({ settings } = await launch())
    const config = await settings.evaluate('window.settingsAPI.getConfig()')
    assert.equal(config.fontSize, 48); assert.equal(config.asr.apiKey, 'framework-synthetic-key')
    await quit(settings)
  }
  console.log(JSON.stringify({ packaged: !!packagedArg, dev, checks: ['two windows', 'React mount', 'Python JSONL', 'live subtitles', 'stop acknowledgement', 'reload', 'manual visibility', 'IPC permissions', 'encrypted secret', ...(!dev ? ['restart persistence'] : ['Vite dev server']), 'graceful shutdown'] }))
  console.log('APPLICATION SMOKE PASS (mock recognition, no microphone/model/API calls)')
}
main().catch(error => { console.error(error.stack || error); console.error(output.slice(-8000)); process.exitCode = 1 }).finally(async () => {
  for (const connection of connections) connection.close()
  if (child && child.exitCode === null) {
    if (process.platform === 'win32') await new Promise(resolve => { const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }); killer.on('exit', resolve); killer.on('error', resolve) })
    else child.kill('SIGKILL')
  }
  try { fs.rmSync(temp, { recursive: true, force: true }) } catch { /* Chromium may still release cache handles. */ }
})
