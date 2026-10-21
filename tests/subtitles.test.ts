import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULTS } from '../src/shared/config'
import { SubtitleController } from '../src/main/modules/subtitles'

function fixture(patch = {}) {
  const config = { ...structuredClone(DEFAULTS), autoHideDelay: 0, ...patch }
  const events = { subtitle: vi.fn(), visibility: vi.fn(), preview: vi.fn() }
  return { config, events, controller: new SubtitleController(() => config, events) }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
describe('字幕策略：直接测试实际运行的控制器，而非截取主进程源码', () => {
  it('实时草稿、定稿立即下发', () => {
    const f = fixture(); f.controller.partial('今天'); expect(f.events.subtitle).toHaveBeenLastCalledWith({ final: '', partial: '今天' })
    f.controller.final('今天聊字幕。'); expect(f.controller.state).toEqual({ final: '今天聊字幕。', partial: '' })
  })
  it('整句模式不下发半句', () => {
    const f = fixture({ subtitleMode: 'sentence' }); f.controller.partial('半句'); expect(f.events.subtitle).not.toHaveBeenCalled()
    f.controller.final('整句。'); expect(f.events.subtitle).toHaveBeenCalledWith({ final: '整句。', partial: '' })
  })
  it('定稿按配置延迟出现', () => {
    const f = fixture({ subtitleMode: 'sentence', sentenceDelay: 600 }); f.controller.final('第一句。')
    vi.advanceTimersByTime(599); expect(f.events.subtitle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1); expect(f.controller.state.final).toBe('第一句。')
  })
  it('延时期间只保留最新整句', () => {
    const f = fixture({ subtitleMode: 'sentence', sentenceDelay: 500 }); f.controller.final('第一句。'); f.controller.final('第二句。')
    vi.advanceTimersByTime(500); expect(f.events.subtitle).toHaveBeenCalledTimes(1); expect(f.controller.state.final).toBe('第二句。')
  })
  it('停止会丢弃未显示的定稿', () => {
    const f = fixture({ subtitleMode: 'sentence', sentenceDelay: 500 }); f.controller.final('旧句'); f.controller.cancelPending()
    vi.runAllTimers(); expect(f.events.subtitle).not.toHaveBeenCalled()
  })
  it('切回实时丢弃待显示整句，恢复草稿', () => {
    const f = fixture({ subtitleMode: 'sentence', sentenceDelay: 500 }); f.controller.final('旧句')
    const previous = { ...f.config }; f.config.subtitleMode = 'realtime'; f.controller.configChanged(previous)
    vi.runAllTimers(); f.controller.partial('新草稿'); expect(f.controller.state).toEqual({ final: '', partial: '新草稿' })
  })
  it('切到整句清除残留半句', () => {
    const f = fixture(); f.controller.partial('半句'); const previous = { ...f.config }; f.config.subtitleMode = 'sentence'; f.controller.configChanged(previous)
    expect(f.controller.state.partial).toBe('')
  })
  it('调整定稿延时重新排期', () => {
    const f = fixture({ subtitleMode: 'sentence', sentenceDelay: 500 }); f.controller.final('一句'); const previous = { ...f.config }; f.config.sentenceDelay = 100
    f.controller.configChanged(previous); vi.advanceTimersByTime(100); expect(f.controller.state.final).toBe('一句')
  })
  it('超时自动隐藏，新内容自动恢复', () => {
    const f = fixture({ autoHideDelay: 2 }); f.controller.final('第一句'); vi.advanceTimersByTime(2000); expect(f.controller.visible).toBe(false)
    f.controller.final('第二句'); expect(f.controller.visible).toBe(true)
  })
  it('手动隐藏不会被新字幕顶开', () => {
    const f = fixture({ autoHideDelay: 1 }); f.controller.setVisible(false); f.controller.final('字幕'); vi.runAllTimers(); expect(f.controller.visible).toBe(false)
  })
  it('预览期间不自动隐藏，清预览后恢复倒计时', () => {
    const f = fixture({ autoHideDelay: 1 }); f.controller.final('字幕'); f.controller.setPreview('预览'); vi.advanceTimersByTime(5000); expect(f.controller.visible).toBe(true)
    f.controller.setPreview(''); vi.advanceTimersByTime(1000); expect(f.controller.visible).toBe(false)
  })
  it('关闭自动隐藏、空字幕不启动倒计时，销毁时清理所有计时器', () => {
    const f = fixture(); f.controller.final('字幕'); expect(vi.getTimerCount()).toBe(0)
    f.config.autoHideDelay = 1; f.controller.final(''); expect(vi.getTimerCount()).toBe(0)
    f.controller.final('字幕'); f.controller.dispose(); expect(vi.getTimerCount()).toBe(0)
  })
})
