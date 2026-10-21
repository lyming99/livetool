import { contextBridge, ipcRenderer } from 'electron'
import type { SettingsAPI } from '../shared/contracts'
import type { Unsubscribe } from '../shared/contracts'

function subscribe<T>(channel: string, callback: (value: T) => void): Unsubscribe {
  const listener = (_event: Electron.IpcRendererEvent, value: T): void => callback(value)
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

const api: SettingsAPI = {
  getConfig: () => ipcRenderer.invoke('config:get'), setConfig: patch => ipcRenderer.invoke('config:set', patch),
  getDefaults: () => ipcRenderer.invoke('config:defaults'), getStatus: () => ipcRenderer.invoke('app:status'),
  getDisplays: () => ipcRenderer.invoke('displays:list'), refreshDisplays: () => ipcRenderer.invoke('displays:refresh'),
  previewText: text => ipcRenderer.invoke('overlay:preview', text), getAudioDevices: () => ipcRenderer.invoke('devices:list'),
  checkEnv: engine => ipcRenderer.invoke('env:check', engine), testMic: () => ipcRenderer.invoke('mic:test'),
  testRecord: seconds => ipcRenderer.invoke('test:record', seconds), testRecognize: () => ipcRenderer.invoke('test:recognize'),
  readRecording: kind => ipcRenderer.invoke('recording:read', kind), runInstall: engine => ipcRenderer.invoke('install:run', engine),
  setClickThrough: value => ipcRenderer.invoke('overlay:set-click-through', value), setOverlayVisible: value => ipcRenderer.invoke('overlay:set-visible', value),
  toggleEngine: () => ipcRenderer.invoke('engine:toggle'), reloadEngine: () => ipcRenderer.invoke('engine:reload'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onConfig: cb => subscribe('config:changed', cb), onSubtitle: cb => subscribe('subtitle:state', cb),
  onStatus: cb => subscribe('engine:status', cb), onDisplaysChanged: cb => subscribe('displays:changed', cb),
  onOverlayVisible: cb => subscribe('overlay:visible', cb), onAudioDevices: cb => subscribe('audio:devices', cb),
  onAudioOutputDevices: cb => subscribe('audio:output-devices', cb), onCaptureSwitch: cb => subscribe('audio:capture-switch', cb),
  onMicTest: cb => subscribe('mic:test', cb), onRecordResult: cb => subscribe('record:result', cb),
  onRecordLevel: cb => subscribe('record:level', cb), onRecognizeResult: cb => subscribe('recognize:result', cb),
  onEnvState: cb => subscribe('env:state', cb), onInstallProgress: cb => subscribe('install:progress', cb)
}
contextBridge.exposeInMainWorld('settingsAPI', api)
