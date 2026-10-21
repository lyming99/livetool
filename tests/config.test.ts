import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULTS, configPatchSchema, mergeConfig, normalizeConfig, overlayConfig } from '../src/shared/config'
import { ConfigRepository, type SecretCodec } from '../src/main/infrastructure/config-repository'
import { redact } from '../src/main/infrastructure/logging'
const directories: string[] = []
const codec: SecretCodec = { available: () => true, encrypt: value => Buffer.from('encrypted:' + value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString().replace('encrypted:', '') }
function fixture(saved?: unknown, secret = codec) {
  fs.mkdirSync('build', { recursive: true }); const directory = fs.mkdtempSync(path.resolve('build/config-test-')); directories.push(directory)
  const file = path.join(directory, 'config.json'); if (saved) fs.writeFileSync(file, JSON.stringify(saved))
  return { file, repository: new ConfigRepository(file, secret) }
}
afterEach(() => { directories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })) })
describe('配置契约与持久化', () => {
  it('首次启动补齐默认值', () => { const f = fixture(); expect(f.repository.load()).toEqual(DEFAULTS) })
  it('损坏、null 或数组配置不阻止应用启动', () => {
    for (const value of ['null', '[]', '{invalid']) {
      const f = fixture(); fs.writeFileSync(f.file, value); expect(f.repository.load()).toEqual(DEFAULTS)
    }
  })
  it('旧数字设备迁移为稳定端点模式并提示确认', () => {
    const config = normalizeConfig({ asr: { audioDevice: 23, recordBackend: 'portaudio' } })
    expect(config.asr.audioDevice).toBeNull(); expect(config.asr.audioDeviceMigrated).toBe(true); expect(config.asr).not.toHaveProperty('recordBackend')
  })
  it('旧配置的错误枚举和非有限数字回退；合法数字限制范围', () => {
    const config = normalizeConfig({ subtitleMode: 'unknown', sentenceDelay: 99999, autoHideDelay: -10, asr: { engine: 'unknown', apiTimeout: 999 } })
    expect(config.subtitleMode).toBe('realtime'); expect(config.sentenceDelay).toBe(10000); expect(config.autoHideDelay).toBe(0)
    expect(config.asr.engine).toBe('funasr'); expect(config.asr.apiTimeout).toBe(120)
  })
  it('IPC 拒绝未知字段、错误类型、无穷数，不把 TS 类型当运行时校验', () => {
    for (const patch of [{ command: 'shutdown' }, { fontSize: 'large' }, { fontSize: Infinity }, { asr: { engine: 'unknown' } }]) expect(configPatchSchema.safeParse(patch).success).toBe(false)
  })
  it('嵌套 ASR 深合并，不抹掉另一来源和模型配置', () => {
    const f = fixture(); const saved = f.repository.save({ asr: { audioDevice: 'microphone-stable-id' } })
    expect(saved.asr.model).toBe(DEFAULTS.asr.model); expect(saved.asr.audioOutputDevice).toBeNull()
    expect(f.repository.save({ asr: { audioOutputDevice: 'speaker' } }).asr.audioDevice).toBe('microphone-stable-id')
  })
  it('显示方式、延时和接口超时边界保持原行为', () => {
    const f = fixture(); expect(f.repository.save({ sentenceDelay: 99999 }).sentenceDelay).toBe(10000)
    expect(f.repository.save({ sentenceDelay: -10 }).sentenceDelay).toBe(0)
    const config = f.repository.save({ asr: { engine: 'api', apiTimeout: 1, apiModel: ' ' } })
    expect(config.asr.engine).toBe('api'); expect(config.asr.apiTimeout).toBe(5); expect(config.asr.apiModel).toBe('whisper-1')
  })
  it('API 密钥持久化为密文，重启能恢复，普通修改不会覆盖它', () => {
    const f = fixture(); f.repository.save({ asr: { apiKey: 'synthetic-secret' } })
    expect(fs.readFileSync(f.file, 'utf8')).not.toContain('synthetic-secret')
    const restart = new ConfigRepository(f.file, codec); expect(restart.load().asr.apiKey).toBe('synthetic-secret')
    restart.save({ fontSize: 52 }); expect(new ConfigRepository(f.file, codec).load().asr.apiKey).toBe('synthetic-secret')
  })
  it('旧明文密钥在下一次成功保存时迁移；明确清空密钥会删除密文', () => {
    const f = fixture(mergeConfig(DEFAULTS, { asr: { apiKey: 'legacy-test-key' } })); f.repository.save({ fontSize: 50 })
    expect(fs.readFileSync(f.file, 'utf8')).not.toContain('legacy-test-key')
    f.repository.save({ asr: { apiKey: '' } }); expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).asr.apiKeyEncrypted).toBeUndefined()
  })
  it('无法加密时明确失败，不落明文、不谎报保存成功', () => {
    const f = fixture(undefined, { ...codec, available: () => false })
    expect(() => f.repository.save({ asr: { apiKey: 'must-not-persist' } })).toThrow('系统密钥服务不可用')
    expect(f.repository.load().asr.apiKey).toBe(''); expect(fs.existsSync(f.file)).toBe(false)
  })
  it('保存失败不改变内存中的已确认配置', () => {
    const f = fixture(); f.repository.load(); vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk busy') })
    expect(() => f.repository.save({ fontSize: 66 })).toThrow('配置保存失败'); expect(f.repository.load().fontSize).toBe(44)
  })
  it('字幕窗口配置不携带密钥，日志也脱敏', () => {
    const config = mergeConfig(DEFAULTS, { asr: { apiKey: 'key-to-redact' } })
    expect(overlayConfig(config).asr.apiKey).toBe(''); expect(config.asr.apiKey).toBe('key-to-redact')
    expect(redact('prefix key-to-redact Bearer abc123 {"apiKey":"another"}', 'key-to-redact')).not.toMatch(/key-to-redact|abc123|another/)
  })
})
