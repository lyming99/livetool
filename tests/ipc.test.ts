import { afterEach, describe, expect, it, vi } from 'vitest'
const handlers = vi.hoisted(() => new Map<string, (event: unknown, value?: unknown) => unknown>())
vi.mock('electron', () => ({ ipcMain: {
  handle: (name: string, handler: (event: unknown, value?: unknown) => unknown) => handlers.set(name, handler),
  removeHandler: (name: string) => handlers.delete(name)
} }))
import { registerIpc, type IpcServices } from '../src/main/ipc'
import { DEFAULTS } from '../src/shared/config'

function fixture() {
  const patchConfig = vi.fn(() => structuredClone(DEFAULTS))
  const services = {
    windows: { getOwner: (id: number) => id === 1 ? 'settings' : id === 2 ? 'overlay' : undefined, displays: () => [] },
    config: { load: () => ({ ...structuredClone(DEFAULTS), asr: { ...DEFAULTS.asr, apiKey: 'synthetic-secret' } }), defaults: () => structuredClone(DEFAULTS) },
    speech: { record: vi.fn(), recognize: vi.fn(), testMic: vi.fn(), listDevices: vi.fn(), checkEnvironment: vi.fn(), install: vi.fn(), toggle: vi.fn(), reload: vi.fn() },
    subtitles: { setPreview: vi.fn(), setVisible: vi.fn() },
    status: vi.fn(), patchConfig, setClickThrough: vi.fn(), openSettings: vi.fn(), refreshDisplays: vi.fn(), recording: vi.fn(), quit: vi.fn()
  } as unknown as IpcServices
  const remove = registerIpc(services)
  const call = (name: string, value?: unknown, id = 1, subframe = false) => {
    const mainFrame = {}; return handlers.get(name)!({ sender: { id, mainFrame }, senderFrame: subframe ? {} : mainFrame }, value)
  }
  return { services, patchConfig, remove, call }
}
afterEach(() => handlers.clear())
describe('IPC 能力和运行时参数校验', () => {
  it('只允许已登记窗口及其主 frame 调用', () => {
    const f = fixture(); expect(() => f.call('config:get', undefined, 99)).toThrow('未授权')
    expect(() => f.call('config:get', undefined, 1, true)).toThrow('未授权')
  })
  it('字幕窗口不能访问密钥、录音文件或引擎控制', () => {
    const f = fixture(); expect((f.call('config:get', undefined, 2) as typeof DEFAULTS).asr.apiKey).toBe('')
    expect(() => f.call('recording:read', 'current', 2)).toThrow('无权'); expect(() => f.call('engine:toggle', undefined, 2)).toThrow('无权')
    expect(() => f.call('config:set', { asr: { apiKey: 'injected' } }, 2)).toThrow('只能调整字幕位置')
  })
  it('字幕窗口可以保存拖动位置', () => {
    const f = fixture(); f.call('config:set', { anchorX: 0.6, offsetY: 90 }, 2); expect(f.patchConfig).toHaveBeenCalledWith({ anchorX: 0.6, offsetY: 90 })
  })
  it('拒绝错误类型、超长预览、非法录音时长与任意文件路径', () => {
    const f = fixture(); expect(() => f.call('test:record', -1)).toThrow(); expect(() => f.call('test:record', '5')).toThrow()
    expect(() => f.call('overlay:set-visible', 'true')).toThrow(); expect(() => f.call('overlay:preview', 'x'.repeat(20001))).toThrow()
    expect(() => f.call('recording:read', 'C:\\outside.wav')).toThrow()
  })
  it('没有任意 bridge:command，卸载时移除全部处理器', () => {
    const f = fixture(); expect(handlers.has('bridge:command')).toBe(false); f.remove(); expect(handlers.size).toBe(0)
  })
})
