import { ipcMain } from 'electron'
import { z } from 'zod'
import { configPatchSchema, engineSchema, overlayConfig, type AppConfig } from '../shared/config'
import type { AppStatus } from '../shared/contracts'
import type { WindowManager } from './platform/windows'
import type { ConfigRepository } from './infrastructure/config-repository'
import type { SpeechService } from './modules/speech'
import type { SubtitleController } from './modules/subtitles'

export interface IpcServices {
  windows: WindowManager; config: ConfigRepository; speech: SpeechService; subtitles: SubtitleController;
  status(): AppStatus; patchConfig(patch: unknown): AppConfig; setClickThrough(value: boolean): boolean;
  openSettings(): void; refreshDisplays(): unknown; recording(kind: 'current' | 'reference'): string | null; quit(): void
}

/** All renderer capabilities are enumerated here; no arbitrary bridge commands or file paths. */
export function registerIpc(services: IpcServices): () => void {
  const names: string[] = []
  const handle = (name: string, run: (value: unknown, owner: 'settings' | 'overlay') => unknown, overlayAllowed = false): void => {
    names.push(name)
    ipcMain.handle(name, (event, value) => {
      const owner = services.windows.getOwner(event.sender.id)
      if (!owner || (event.senderFrame && event.senderFrame !== event.sender.mainFrame)) throw new Error('未授权的 IPC 来源')
      if (owner === 'overlay' && !overlayAllowed) throw new Error('字幕窗口无权调用此接口')
      return run(value, owner)
    })
  }
  handle('config:get', (_value, owner) => owner === 'overlay' ? overlayConfig(services.config.load()) : services.config.load(), true)
  handle('config:set', (value, owner) => {
    const patch = configPatchSchema.parse(value)
    if (owner === 'overlay' && Object.keys(patch).some(key => key !== 'anchorX' && key !== 'offsetY')) throw new Error('字幕窗口只能调整字幕位置')
    const config = services.patchConfig(patch)
    return owner === 'overlay' ? overlayConfig(config) : config
  }, true)
  handle('config:defaults', () => services.config.defaults())
  handle('app:status', () => services.status())
  handle('displays:list', () => services.windows.displays())
  handle('displays:refresh', () => services.refreshDisplays())
  handle('devices:list', () => services.speech.listDevices())
  handle('env:check', value => services.speech.checkEnvironment(engineSchema.parse(value)))
  handle('install:run', value => services.speech.install(engineSchema.parse(value)))
  handle('mic:test', () => services.speech.testMic())
  handle('test:record', value => services.speech.record(z.number().finite().min(0).max(60).parse(value)))
  handle('test:recognize', () => services.speech.recognize())
  handle('engine:toggle', () => services.speech.toggle())
  handle('engine:reload', () => services.speech.reload())
  handle('recording:read', value => services.recording(z.enum(['current', 'reference']).default('current').parse(value)))
  handle('overlay:preview', value => services.subtitles.setPreview(z.string().max(20000).parse(value)))
  handle('overlay:set-visible', value => services.subtitles.setVisible(z.boolean().parse(value)))
  handle('overlay:set-click-through', value => services.setClickThrough(z.boolean().parse(value)), true)
  handle('app:open-settings', () => services.openSettings(), true)
  handle('app:quit', () => services.quit())
  return () => names.forEach(name => ipcMain.removeHandler(name))
}
