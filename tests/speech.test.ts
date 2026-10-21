import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpeechService } from '../src/main/modules/speech'
import { PythonBridge, type BridgePort } from '../src/main/infrastructure/python-bridge'
import { DEFAULTS } from '../src/shared/config'
import type { BackendCommand } from '../src/shared/contracts'
class Bridge extends EventEmitter implements BridgePort {
  pid = 123; commands: BackendCommand[] = []; available = true
  start = vi.fn(); stop = vi.fn()
  send(command: BackendCommand) { this.commands.push(command); return this.available }
}
function fixture() {
  const bridge = new Bridge(); const factory = vi.fn(() => bridge); const service = new SpeechService(factory, () => structuredClone(DEFAULTS), true)
  return { bridge, service, factory }
}
afterEach(() => vi.useRealTimers())
describe('识别进程与诊断生命周期', () => {
  it('后端启动首次报告就绪后才查询设备，不靠固定启动延时', () => {
    const f = fixture(); f.service.ensure(); expect(f.bridge.commands).toEqual([])
    f.bridge.emit('message', { type: 'status', state: 'idle' }); expect(f.bridge.commands.map(command => command.type)).toEqual(['list_devices', 'check_env'])
  })
  it('冷启动 idle 不能撤销已发送的开始请求', () => {
    const f = fixture(); expect(f.service.start()).toBe(true); f.bridge.emit('message', { type: 'status', state: 'idle' })
    expect(f.service.running).toBe(true); expect(f.service.status.state).toBe('starting')
  })
  it('发送失败不报告录音或识别已开始', () => {
    const f = fixture(); f.bridge.available = false; expect(f.service.record(5)).toBe(false); expect(f.service.recognize()).toBe(false); expect(f.service.start()).toBe(false)
  })
  it('0 只对应停止录制，终态后可再次录制', () => {
    const f = fixture(); expect(f.service.record(5)).toBe(true); expect(f.service.record(0)).toBe(true)
    expect(f.bridge.commands.map(command => command.type)).toEqual(['record_test', 'stop_record'])
    f.bridge.emit('message', { type: 'record_result', ok: true, path: 'current.wav' }); expect(f.service.recordingPath).toBe('current.wav'); expect(f.service.record(5)).toBe(true)
  })
  it('录制、识别、实时运行互斥', () => {
    const f = fixture(); f.service.record(5); expect(f.service.recognize()).toBe(false); expect(f.service.start()).toBe(false)
    f.bridge.emit('message', { type: 'record_result', ok: false }); expect(f.service.start()).toBe(true); expect(f.service.record(5)).toBe(false)
  })
  it('重载必须收到 stopped 才发送新的 start', async () => {
    const f = fixture(); f.service.ensure(); f.bridge.emit('message', { type: 'status', state: 'idle' }); f.bridge.commands.length = 0
    f.service.start(); const reloading = f.service.reload()
    expect(f.bridge.commands.map(command => command.type)).toEqual(['start', 'stop'])
    f.bridge.emit('message', { type: 'status', state: 'stopped' }); await expect(reloading).resolves.toBe(true)
    expect(f.bridge.commands.map(command => command.type)).toEqual(['start', 'stop', 'start']); expect(f.bridge.listenerCount('exit')).toBe(1)
  })
  it('并发重载共用一次停止/启动序列', async () => {
    const f = fixture(); f.service.start(); const one = f.service.reload(); const two = f.service.reload()
    f.bridge.emit('message', { type: 'status', state: 'stopped' }); await Promise.all([one, two]); expect(f.bridge.commands.filter(command => command.type === 'start')).toHaveLength(2)
  })
  it('停止超时不会假装成功，会清理等待监听器', async () => {
    vi.useFakeTimers(); const f = fixture(); f.service.start(); const action = f.service.toggle(); const expected = expect(action).rejects.toThrow('停止确认超时')
    await vi.advanceTimersByTimeAsync(15000); await expected; expect(f.service.status.state).toBe('error'); expect(f.bridge.listenerCount('exit')).toBe(1)
  })
  it('运行错误保留停止入口，进程退出则复位诊断', () => {
    const f = fixture(); f.service.start(); f.bridge.emit('message', { type: 'status', state: 'error', detail: 'device error' }); expect(f.service.running).toBe(true)
    f.bridge.emit('exit', { code: 1 }); expect(f.service.running).toBe(false)
    const g = fixture(); const result = vi.fn(); g.service.on('record:result', result); g.service.record(5); g.bridge.emit('exit', { code: 1 }); expect(g.service.recording).toBe(false); expect(result).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })
  it('来源切换只下发 switch_capture，不重载模型', () => {
    const f = fixture(); f.service.start(); f.service.switchCapture(); expect(f.bridge.commands.map(command => command.type)).toEqual(['start', 'switch_capture'])
  })
  it('spawn 失败即使没有 exit 事件也能释放桥接器并重试', async () => {
    const factory = vi.fn(() => new PythonBridge({ executable: 'livetool-deliberately-missing-executable', cwd: process.cwd() }))
    const service = new SpeechService(factory, () => structuredClone(DEFAULTS), false)
    const failedBridge = service.ensure()
    // error precedes close; retry is valid only after the close cleanup ran.
    await new Promise<void>(resolve => failedBridge.on('exit', () => resolve()))
    expect(service.status.state).toBe('error')
    const before = factory.mock.calls.length
    service.ensure(); expect(factory).toHaveBeenCalledTimes(before + 1)
    await service.dispose()
  })
  it('无效 JSON/事件不会进入业务处理，普通日志仍可收集', () => {
    const bridge = new PythonBridge({ executable: 'not-started', cwd: '.', mock: true }); const message = vi.fn(); const log = vi.fn(); bridge.on('message', message); bridge.on('log', log)
    bridge.acceptLine('third party log'); bridge.acceptLine('{"type":"final","text":12}'); bridge.acceptLine('{"type":"final","text":"合法字幕"}')
    expect(log).toHaveBeenCalledTimes(2); expect(message).toHaveBeenCalledExactlyOnceWith({ type: 'final', text: '合法字幕' })
  })
})
