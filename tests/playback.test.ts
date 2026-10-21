import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RecordingPlayback } from '../src/renderer/settings/model/playback'
import { deferred } from './helpers'
const audios: { pause: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn>; playbackRate: number }[] = []
function createAudio() {
  const audio = { pause: vi.fn(), play: vi.fn(async () => {}), load: vi.fn(), removeAttribute: vi.fn(), addEventListener: vi.fn(), playbackRate: 1 }
  audios.push(audio); return audio as unknown as HTMLAudioElement
}
beforeEach(() => { audios.length = 0; vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}) })
afterEach(() => vi.restoreAllMocks())
describe('录音播放资源', () => {
  it('连续播放先暂停旧音频、释放旧 URL，保持正常速率', async () => {
    const read = vi.fn(async () => Buffer.from('RIFF synthetic').toString('base64'))
    const player = new RecordingPlayback(read, createAudio); await player.play(); await player.play()
    expect(read).toHaveBeenCalledWith('current'); expect(audios).toHaveLength(2); expect(audios[0].pause).toHaveBeenCalledOnce(); expect(audios[1].playbackRate).toBe(1)
    player.stop(); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })
  it('开始新录音/卸载后，迟到的读取不能创建旧播放', async () => {
    const gate = deferred<string | null>(); const player = new RecordingPlayback(() => gate.promise, createAudio)
    const playing = player.play(); player.stop(); gate.resolve(Buffer.from('RIFF').toString('base64')); await playing
    expect(audios).toHaveLength(0); expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
  it('读取失败明确报错，不创建音频对象', async () => {
    const player = new RecordingPlayback(async () => null, createAudio); await expect(player.play()).rejects.toThrow('读不到录音文件'); expect(audios).toHaveLength(0)
  })
  it('解码/播放失败也释放资源', async () => {
    const player = new RecordingPlayback(async () => Buffer.from('RIFF').toString('base64'), () => {
      const audio = createAudio(); vi.mocked(audio.play).mockRejectedValue(new Error('unsupported WAV')); return audio
    })
    await expect(player.play()).rejects.toThrow('unsupported WAV'); expect(URL.revokeObjectURL).toHaveBeenCalledOnce(); expect(audios[0].pause).toHaveBeenCalledOnce()
  })
})
