'use strict'
// 用真实 Electron/Chromium 验证 IPC base64 -> WAV Blob -> 播放。
// 使用独立临时 userData，播放静音合成音，不改动已安装应用和用户录音。
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const ROOT = path.join(__dirname, '..')
const temp = fs.mkdtempSync(path.join(ROOT, 'build', 'playback-test-'))
app.setPath('userData', temp)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

function wav (rate) {
  const frames = Math.round(rate * 0.25)
  const buffer = Buffer.alloc(44 + frames * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(frames * 2, 40)
  for (let i = 0; i < frames; i++) buffer.writeInt16LE(Math.round(1000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2)
  return buffer
}

let audioBytes = wav(44100)
ipcMain.handle('recording:read', () => audioBytes.toString('base64'))
const timeout = setTimeout(() => { console.error('PLAYBACK TIMEOUT'); app.exit(1) }, 20000)

app.whenReady().then(async () => {
  let win
  let code = 0
  try {
    win = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(ROOT, 'out/preload/settings.js'), contextIsolation: true, nodeIntegration: false }
    })
    await win.loadURL('data:text/html,<html><body>recording playback regression</body></html>')
    for (const rate of [44100, 48000]) {
      audioBytes = wav(rate)
      const result = await win.webContents.executeJavaScript(`(async () => {
        const b64 = await window.settingsAPI.readRecording()
        const bin = atob(b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
        const audio = new Audio(url)
        audio.muted = true
        audio.playbackRate = 1
        try {
          const ended = new Promise((resolve, reject) => {
            audio.addEventListener('ended', resolve, { once: true })
            audio.addEventListener('error', () => reject(new Error(audio.error?.message || 'unsupported WAV')), { once: true })
          })
          await audio.play()
          await ended
          return { duration: audio.duration, playbackRate: audio.playbackRate, ended: audio.ended }
        } finally {
          audio.pause()
          audio.removeAttribute('src')
          audio.load()
          URL.revokeObjectURL(url)
        }
      })()`)
      assert.equal(result.playbackRate, 1)
      assert.equal(result.ended, true)
      assert.ok(Math.abs(result.duration - 0.25) < 0.002)
      console.log(JSON.stringify({ rate, ...result }))
    }
    console.log('ELECTRON PLAYBACK PASS: 44100Hz and 48000Hz WAV over real IPC/Blob')
  } catch (err) {
    code = 1
    console.error(err.stack || err)
  } finally {
    clearTimeout(timeout)
    if (win && !win.isDestroyed()) win.destroy()
    // app.exit 不触发 will-quit，清理必须放在退出前。
    try { fs.rmSync(temp, { recursive: true, force: true }) } catch (_) { /* Chromium 仍可能占用临时缓存文件 */ }
    app.exit(code)
  }
})
