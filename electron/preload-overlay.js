'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlayAPI', {
  onSubtitle: (cb) => ipcRenderer.on('subtitle:state', (_e, s) => cb(s)),
  onPreview: (cb) => ipcRenderer.on('subtitle:preview', (_e, text) => cb(text)),
  onMetrics: (cb) => ipcRenderer.on('overlay:metrics', () => cb()),
  onConfig: (cb) => ipcRenderer.on('config:changed', (_e, c) => cb(c)),
  onStatus: (cb) => ipcRenderer.on('engine:status', (_e, s) => cb(s)),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  setClickThrough: (v) => ipcRenderer.invoke('overlay:set-click-through', v),
  openSettings: () => ipcRenderer.invoke('app:open-settings')
})
