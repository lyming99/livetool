import { contextBridge, ipcRenderer } from 'electron'
import type { OverlayAPI } from '../shared/contracts'
import type { Unsubscribe } from '../shared/contracts'

function subscribe<T>(channel: string, callback: (value: T) => void): Unsubscribe {
  const listener = (_event: Electron.IpcRendererEvent, value: T): void => callback(value)
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

const api: OverlayAPI = {
  onSubtitle: cb => subscribe('subtitle:state', cb), onPreview: cb => subscribe('subtitle:preview', cb),
  onMetrics: cb => subscribe('overlay:metrics', cb), onConfig: cb => subscribe('config:changed', cb),
  onStatus: cb => subscribe('engine:status', cb), getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: patch => ipcRenderer.invoke('config:set', patch),
  setClickThrough: value => ipcRenderer.invoke('overlay:set-click-through', value),
  openSettings: () => ipcRenderer.invoke('app:open-settings')
}
contextBridge.exposeInMainWorld('overlayAPI', api)
