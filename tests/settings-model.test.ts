import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsModel } from '../src/renderer/settings/model/settings-model'
import { apiFixture, deferred, status } from './helpers'
import { DEFAULTS } from '../src/shared/config'
afterEach(() => vi.useRealTimers())
describe('React 模型生命周期与状态同步', () => {
  it('重挂载清理所有订阅和轮询，不累积监听器', async () => {
    vi.useFakeTimers(); const f = apiFixture(); const model = new SettingsModel(f.api); const stop = model.connect()
    await Promise.resolve(); await Promise.resolve(); expect(f.count()).toBe(14); stop(); expect(f.count()).toBe(0); expect(vi.getTimerCount()).toBe(0)
    const again = model.connect(); expect(f.count()).toBe(14); again(); model.dispose(); expect(f.count()).toBe(0)
  })
  it('托盘/快捷键更改显隐时，配置推送不会把运行状态改回去', () => {
    vi.useFakeTimers(); const f = apiFixture(); const model = new SettingsModel(f.api); const stop = model.connect()
    f.emit('OverlayVisible', false); f.emit('Config', structuredClone(DEFAULTS)); expect(model.getSnapshot().status.overlayVisible).toBe(false); stop(); model.dispose()
  })
  it('迟到的状态响应不能覆盖较新的引擎事件', async () => {
    vi.useFakeTimers(); const f = apiFixture(); const gate = deferred<ReturnType<typeof status>>()
    vi.mocked(f.api.getStatus).mockReturnValue(gate.promise); const model = new SettingsModel(f.api); const stop = model.connect()
    const reading = model.refreshStatus(); f.emit('Status', { state: 'running', detail: '新的状态' }); gate.resolve(status({ running: true, engine: { state: 'running', detail: '新的状态' } })); await reading
    expect(model.getSnapshot().status.engine.state).toBe('running'); stop(); model.dispose()
  })
  it('切换采集来源保留两套设备选择，并展示切换结果', () => {
    vi.useFakeTimers(); const f = apiFixture(); const model = new SettingsModel(f.api); const stop = model.connect(); f.emit('Config', structuredClone(DEFAULTS))
    model.edit({ asr: { audioDevice: 'microphone', audioOutputDevice: 'speaker' } }); model.edit({ asr: { captureSource: 'output' } })
    expect(model.getSnapshot().config?.asr.audioDevice).toBe('microphone'); expect(model.getSnapshot().config?.asr.audioOutputDevice).toBe('speaker')
    f.emit('CaptureSwitch', { ok: true, applied: true, kind: 'output' }); expect(model.getSnapshot().captureHint).toContain('已实时切换到电脑声音'); stop(); model.dispose()
  })
  it('安装日志最多保留 300 行', () => {
    vi.useFakeTimers(); const f = apiFixture(); const model = new SettingsModel(f.api); const stop = model.connect()
    for (let i = 0; i < 350; i++) f.emit('InstallProgress', { phase: 'log', message: String(i) })
    expect(model.getSnapshot().installLines).toHaveLength(300); expect(model.getSnapshot().installLines[0]).toBe('50'); stop(); model.dispose()
  })
})
