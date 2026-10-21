import { BrowserWindow, screen, type Display } from 'electron'
import path from 'node:path'
import type { ConfigRepository } from '../infrastructure/config-repository'
import type { DisplayInfo } from '../../shared/contracts'

export interface WindowOptions {
  outDirectory: string; devServer?: string;
  onOverlayReady(): void; onSettingsReady(): void; onConfigChanged(): void; onEscape(): void
}

/** OS window behavior stays outside subtitle/recognition business services. */
export class WindowManager {
  overlay: BrowserWindow | null = null
  settings: BrowserWindow | null = null
  constructor(private readonly config: ConfigRepository, private readonly options: WindowOptions) {}
  private load(window: BrowserWindow, page: 'settings' | 'overlay'): void {
    if (this.options.devServer) void window.loadURL(new URL(page + '.html', this.options.devServer).href)
    else void window.loadFile(path.join(this.options.outDirectory, 'renderer', page + '.html'))
  }
  private preferences(page: 'settings' | 'overlay'): Electron.WebPreferences {
    return {
      preload: path.join(this.options.outDirectory, 'preload', page + '.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: page !== 'overlay', spellcheck: false
    }
  }
  private protect(window: BrowserWindow): void {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
  }
  target(): Display {
    const cfg = this.config.load()
    const displays = screen.getAllDisplays()
    const id = cfg.displayId === null ? undefined : displays.find(display => String(display.id) === String(cfg.displayId))
    if (id) return id
    const byLabel = cfg.displayLabel ? displays.find(display => display.label === cfg.displayLabel) : undefined
    if (byLabel) {
      this.config.save({ displayId: byLabel.id })
      return byLabel
    }
    if (cfg.displayId !== null || cfg.displayLabel) this.config.save({ displayId: null, displayLabel: null })
    return screen.getPrimaryDisplay()
  }
  displays(): DisplayInfo[] {
    const primary = screen.getPrimaryDisplay().id
    return screen.getAllDisplays().map((display, index) => ({
      id: display.id, label: display.label || `显示器 ${index + 1}`,
      displayKey: `${display.label || ''}|${display.bounds.width}x${display.bounds.height}`,
      width: display.bounds.width, height: display.bounds.height,
      workWidth: display.workArea.width, workHeight: display.workArea.height,
      x: display.bounds.x, y: display.bounds.y, scaleFactor: display.scaleFactor,
      rotation: display.rotation, primary: display.id === primary
    }))
  }
  fitOverlay(): void {
    if (!this.overlay || this.overlay.isDestroyed()) return
    const next = this.target().workArea
    const old = this.overlay.getBounds()
    if (['x', 'y', 'width', 'height'].some(key => old[key as keyof Electron.Rectangle] !== next[key as keyof Electron.Rectangle])) this.overlay.setBounds(next)
    this.overlay.webContents.send('overlay:metrics')
  }
  createOverlay(): void {
    if (this.overlay && !this.overlay.isDestroyed()) return
    const window = new BrowserWindow({
      ...this.target().workArea, transparent: true, backgroundColor: '#00000000', frame: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, hasShadow: false, focusable: false, alwaysOnTop: true, show: false,
      enableLargerThanScreen: true, webPreferences: this.preferences('overlay')
    })
    this.overlay = window
    this.protect(window)
    window.setAlwaysOnTop(true, 'screen-saver')
    window.setIgnoreMouseEvents(this.config.load().clickThrough, { forward: true })
    window.once('ready-to-show', () => window.showInactive())
    window.webContents.on('did-finish-load', this.options.onOverlayReady)
    window.webContents.on('before-input-event', (event, input) => {
      if (!this.config.load().clickThrough && input.type === 'keyDown' && (input.key === 'Escape' || input.code === 'Escape')) {
        event.preventDefault(); this.options.onEscape()
      }
    })
    window.on('closed', () => { this.overlay = null })
    this.load(window, 'overlay')
  }
  openSettings(): void {
    if (this.settings && !this.settings.isDestroyed()) {
      this.raiseSettings(); this.settings.show(); this.settings.focus(); return
    }
    const window = new BrowserWindow({
      width: 580, height: 760, minWidth: 500, minHeight: 600, title: '字幕设置',
      autoHideMenuBar: true, backgroundColor: '#111318', show: false, webPreferences: this.preferences('settings')
    })
    this.settings = window
    this.protect(window)
    window.setMenuBarVisibility(false)
    window.once('ready-to-show', () => { this.raiseSettings(); window.show(); window.focus() })
    window.on('focus', () => this.raiseSettings())
    window.on('blur', () => { if (!window.isDestroyed()) window.setAlwaysOnTop(false) })
    window.webContents.on('did-finish-load', this.options.onSettingsReady)
    window.on('closed', () => { this.settings = null })
    this.load(window, 'settings')
  }
  private raiseSettings(): void {
    if (!this.settings || this.settings.isDestroyed()) return
    this.settings.setAlwaysOnTop(true, 'screen-saver'); this.settings.moveTop()
  }
  setClickThrough(value: boolean): void {
    if (!this.overlay || this.overlay.isDestroyed()) return
    this.overlay.setIgnoreMouseEvents(value, { forward: true })
    this.overlay.setFocusable(!value)
    if (!value) this.overlay.focus()
  }
  setVisible(value: boolean): void {
    if (!this.overlay || this.overlay.isDestroyed()) return
    if (value) { this.fitOverlay(); this.overlay.showInactive() } else this.overlay.hide()
  }
  send(channel: string, value: unknown): void {
    for (const window of [this.overlay, this.settings]) if (window && !window.isDestroyed()) window.webContents.send(channel, value)
  }
  getOwner(id: number): 'settings' | 'overlay' | undefined {
    if (this.settings?.webContents.id === id) return 'settings'
    if (this.overlay?.webContents.id === id) return 'overlay'
    return undefined
  }
}
