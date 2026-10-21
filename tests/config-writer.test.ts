import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigWriter } from '../src/renderer/settings/model/config-writer'
import { DEFAULTS, mergeConfig, type AppConfig } from '../src/shared/config'
import { deferred } from './helpers'
afterEach(() => vi.useRealTimers())
function fixture(save = vi.fn(async (patch) => mergeConfig(DEFAULTS, patch))) {
  const changed = vi.fn(); const failed = vi.fn(); const writer = new ConfigWriter(save, changed, failed); writer.accept(structuredClone(DEFAULTS)); return { writer, save, changed, failed }
}
describe('串行配置保存', () => {
  it('无配置变更时保持对象引用，避免字幕事件触发所有面板重绘', () => {
    vi.useFakeTimers(); const f = fixture(); const first = f.writer.value
    expect(f.writer.value).toBe(first); f.writer.edit({ fontSize: 60 }); expect(f.writer.value).not.toBe(first); f.writer.dispose()
  })
  it('多个 ASR 补丁合并而不互相覆盖', async () => {
    const f = fixture(); f.writer.edit({ asr: { audioDevice: 'stable-id' } }); f.writer.edit({ asr: { apiModel: 'custom' } }); await f.writer.flush()
    expect(f.save).toHaveBeenCalledExactlyOnceWith({ asr: { audioDevice: 'stable-id', apiModel: 'custom' } })
  })
  it('实时回填不能覆盖未保存的草稿', () => {
    vi.useFakeTimers(); const f = fixture(); f.writer.edit({ fontSize: 70 }); f.writer.accept(mergeConfig(DEFAULTS, { color: '#ff0000' }))
    expect(f.writer.value?.fontSize).toBe(70); expect(f.writer.value?.color).toBe('#ff0000'); f.writer.dispose()
  })
  it('前一次保存未完成时，后一次不会并发发出', async () => {
    const gate = deferred<AppConfig>(); const save = vi.fn(async patch => mergeConfig(DEFAULTS, patch)); save.mockImplementationOnce(() => gate.promise)
    const f = fixture(save); f.writer.edit({ fontSize: 50 }); const one = f.writer.flush(); f.writer.edit({ opacity: 0.6 }); const two = f.writer.flush()
    expect(save).toHaveBeenCalledTimes(1); gate.resolve(mergeConfig(DEFAULTS, { fontSize: 50 })); await one; await two; expect(save).toHaveBeenCalledTimes(2)
  })
  it('保存失败保留草稿，允许明确重试', async () => {
    const f = fixture(); f.save.mockRejectedValueOnce(new Error('disk busy')); f.writer.edit({ fontSize: 55 })
    await expect(f.writer.flush()).rejects.toThrow('disk busy'); expect(f.writer.value?.fontSize).toBe(55)
    await f.writer.flush(); expect(f.save).toHaveBeenCalledTimes(2)
  })
  it('失败的旧请求不能覆盖之后排队的新值', async () => {
    const gate = deferred<AppConfig>(); const save = vi.fn(async patch => mergeConfig(DEFAULTS, patch)); save.mockImplementationOnce(() => gate.promise)
    const f = fixture(save); f.writer.edit({ fontSize: 50 }); const one = f.writer.flush().catch(() => {})
    f.writer.edit({ fontSize: 80 }); const two = f.writer.flush().catch(() => {}); gate.reject(new Error('disk busy')); await one; await two
    expect(f.writer.value?.fontSize).toBe(80); await f.writer.flush(); expect(save).toHaveBeenLastCalledWith({ fontSize: 80 })
  })
  it('防抖保存可由录音前 flush 立即完成', async () => {
    vi.useFakeTimers(); const f = fixture(); f.writer.edit({ asr: { audioDevice: 'endpoint' } }); expect(f.save).not.toHaveBeenCalled()
    await f.writer.flush(); expect(f.save).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
  })
})
