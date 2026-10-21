import { describe, expect, it, vi } from 'vitest'
import { DiagnosticsController } from '../src/renderer/settings/model/diagnostics'
import { apiFixture, deferred, status } from './helpers'
function fixture() {
  const f = apiFixture(); const flush = vi.fn(async () => {}); const changed = vi.fn()
  const controller = new DiagnosticsController(f.api, flush, () => false, () => false, changed)
  return { ...f, controller, flush, changed, result: () => controller.recorded({ ok: true, path: 'record.wav', peak: 0.2, duration: 5, sampleRate: 44100 }) }
}
describe('录音与识别状态：迁移原 VM 回归场景', () => {
  it('自然结束后连续录制三次', async () => {
    const f = fixture(); for (let i = 0; i < 3; i++) { await f.controller.record(); expect(f.controller.state.phase).toBe('recording'); f.result(); expect(f.controller.state.phase).toBe('idle') }
    expect(f.api.testRecord).toHaveBeenCalledTimes(3)
  })
  it('采集开始前只提示准备，收到电平才提示说话', async () => {
    const f = fixture(); await f.controller.record(); expect(f.controller.state.lines[0].text).toContain('正在准备录音')
    f.controller.level({ level: 0, elapsed: 0.1, duration: 5 }); expect(f.controller.state.lines[0].text).toContain('正在录制，请对着麦克风说话')
  })
  it('提前停止只发送一次，终态前不能重入', async () => {
    const f = fixture(); await f.controller.record(); await f.controller.record(); await f.controller.record()
    expect(vi.mocked(f.api.testRecord).mock.calls.map(call => call[0])).toEqual([5, 0]); expect(f.controller.state.phase).toBe('stopping')
    f.result(); await f.controller.record(); expect(f.api.testRecord).toHaveBeenLastCalledWith(5)
  })
  it('IPC false/拒绝复位，后续允许重试', async () => {
    const f = fixture(); vi.mocked(f.api.testRecord).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('IPC failure'))
    await f.controller.record(); expect(f.controller.state.phase).toBe('idle'); expect(f.controller.state.lines[0].text).toContain('录制失败')
    await f.controller.record(); expect(f.controller.state.lines[0].text).toContain('IPC failure')
    await f.controller.record(); expect(f.controller.state.phase).toBe('recording')
  })
  it('后端失败终态清除可播放路径', async () => {
    const f = fixture(); await f.controller.record(); f.controller.recorded({ ok: false, detail: 'device busy' })
    expect(f.controller.state.path).toBeNull(); expect(f.controller.busy).toBe(false)
    await f.controller.play(); expect(f.api.readRecording).not.toHaveBeenCalled()
  })
  it('等待设备保存时快速连点，不误发停止', async () => {
    const f = fixture(); const gate = deferred<void>(); f.flush.mockImplementation(() => gate.promise)
    const first = f.controller.record(); await f.controller.record(); expect(f.api.testRecord).not.toHaveBeenCalled()
    expect(f.controller.state.phase).toBe('starting'); gate.resolve(); await first; expect(f.api.testRecord).toHaveBeenCalledExactlyOnceWith(5)
  })
  it('迟到的初始状态不覆盖已开始的本地录音', async () => {
    const f = fixture(); await f.controller.record(); f.controller.hydrate(status()); expect(f.controller.state.phase).toBe('recording')
    await f.controller.record(); expect(f.api.testRecord).toHaveBeenLastCalledWith(0)
  })
  it('重开设置页能接续录音和识别状态', () => {
    const f = fixture(); f.controller.hydrate(status({ recording: true })); expect(f.controller.recording).toBe(true)
    const g = fixture(); g.controller.hydrate(status({ recognizing: true, recordingPath: 'record.wav' })); expect(g.controller.state.phase).toBe('recognizing')
  })
  it('录制和识别互斥，完成识别后恢复', async () => {
    const f = fixture(); f.result(); await f.controller.recognize(); await f.controller.record()
    expect(f.api.testRecord).not.toHaveBeenCalled(); expect(f.api.testRecognize).toHaveBeenCalledOnce()
    f.controller.recognized({ ok: true, text: '识别成功', duration: 5, inferSeconds: 0.1 }); await f.controller.record(); expect(f.api.testRecord).toHaveBeenCalledWith(5)
  })
  it('终态早于 IPC 确认时不复活已经完成的录音', async () => {
    const f = fixture(); const gate = deferred<boolean>(); vi.mocked(f.api.testRecord).mockReturnValue(gate.promise)
    const action = f.controller.record(); await Promise.resolve(); f.result(); gate.resolve(true); await action
    expect(f.controller.state.phase).toBe('idle'); expect(f.controller.state.path).toBe('record.wav')
  })
  it('采集警告保留，并区分电脑声音与麦克风', () => {
    const f = fixture(); f.controller.recorded({ ok: true, path: 'r.wav', captureSource: 'output', peak: 0, discontinuities: 2, overflows: 1, clipped: 2 })
    const text = f.controller.state.lines.map(line => line.text).join('\n')
    expect(text).toContain('WASAPI'); expect(text).toContain('静音'); expect(text).toContain('不连续'); expect(text).toContain('削顶')
  })
  it('失败后的迟到状态不能恢复旧录音路径', async () => {
    const f = fixture(); const revision = f.controller.revision
    await f.controller.record(); f.controller.recorded({ ok: false, detail: 'failed' })
    f.controller.hydrate(status({ recordingPath: 'old.wav' }), revision)
    expect(f.controller.state.path).toBeNull()
  })
  it('保存失败时不开始录音', async () => {
    const f = fixture(); f.flush.mockRejectedValue(new Error('disk failure')); await f.controller.record()
    expect(f.api.testRecord).not.toHaveBeenCalled(); expect(f.controller.state.phase).toBe('idle')
  })
})
