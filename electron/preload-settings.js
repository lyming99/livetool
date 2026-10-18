'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('settingsAPI', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  getDefaults: () => ipcRenderer.invoke('config:defaults'),
  onConfig: (cb) => ipcRenderer.on('config:changed', (_e, c) => cb(c)),
  onSubtitle: (cb) => ipcRenderer.on('subtitle:state', (_e, s) => cb(s)),
  onStatus: (cb) => ipcRenderer.on('engine:status', (_e, s) => cb(s)),
  getStatus: () => ipcRenderer.invoke('app:status'),
  getDisplays: () => ipcRenderer.invoke('displays:list'),
  refreshDisplays: () => ipcRenderer.invoke('displays:refresh'),
  onDisplaysChanged: (cb) => ipcRenderer.on('displays:changed', (_e, list) => cb(list)),
  onOverlayVisible: (cb) => ipcRenderer.on('overlay:visible', (_e, v) => cb(v)),
  previewText: (text) => ipcRenderer.invoke('overlay:preview', text),
  getAudioDevices: () => ipcRenderer.invoke('devices:list'),
  onAudioDevices: (cb) => ipcRenderer.on('audio:devices', (_e, list) => cb(list)),
  checkEnv: (engine) => ipcRenderer.invoke('env:check', engine),
  onEnvState: (cb) => ipcRenderer.on('env:state', (_e, state) => cb(state)),
  testMic: () => ipcRenderer.invoke('mic:test'),
  onMicTest: (cb) => ipcRenderer.on('mic:test', (_e, result) => cb(result)),
  testRecord: (seconds) => ipcRenderer.invoke('test:record', seconds),
  onRecordResult: (cb) => ipcRenderer.on('record:result', (_e, result) => cb(result)),
  onRecordLevel: (cb) => ipcRenderer.on('record:level', (_e, level) => cb(level)),
  testRecognize: () => ipcRenderer.invoke('test:recognize'),
  onRecognizeResult: (cb) => ipcRenderer.on('recognize:result', (_e, result) => cb(result)),
  readRecording: (kind) => ipcRenderer.invoke('recording:read', kind),
  runInstall: (engine) => ipcRenderer.invoke('install:run', engine),
  onInstallProgress: (cb) => ipcRenderer.on('install:progress', (_e, p) => cb(p)),
  setClickThrough: (v) => ipcRenderer.invoke('overlay:set-click-through', v),
  setOverlayVisible: (v) => ipcRenderer.invoke('overlay:set-visible', v),
  sendCommand: (cmd) => ipcRenderer.invoke('bridge:command', cmd),
  toggleEngine: () => ipcRenderer.invoke('engine:toggle'),
  reloadEngine: () => ipcRenderer.invoke('engine:reload'),
  quit: () => ipcRenderer.invoke('app:quit')
})
