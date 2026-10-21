import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS, configPatchSchema, mergeConfig, normalizeConfig, type AppConfig, type ConfigPatch } from '../../shared/config'

export interface SecretCodec { available(): boolean; encrypt(value: string): string; decrypt(value: string): string }

/** Application service storage. No Electron imports, so migration/atomic-write behavior is unit-testable. */
export class ConfigRepository {
  private cache: AppConfig | null = null
  private encryptedKey: string | undefined
  constructor(readonly file: string, private readonly secrets?: SecretCodec) {}

  load(): AppConfig {
    if (this.cache) return structuredClone(this.cache)
    let saved: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[config] 配置读取失败，使用默认值:', String(error))
    }
    const asr = saved.asr && typeof saved.asr === 'object' ? { ...saved.asr as Record<string, unknown> } : {}
    if (typeof asr.apiKeyEncrypted === 'string') {
      this.encryptedKey = asr.apiKeyEncrypted
      try {
        if (!this.secrets?.available()) throw new Error('系统密钥服务不可用')
        asr.apiKey = this.secrets.decrypt(this.encryptedKey)
      } catch { asr.apiKey = ''; console.error('[config] 无法解密接口密钥，请在设置中重新输入；原密文将保留') }
    }
    this.cache = normalizeConfig({ ...saved, asr })
    return structuredClone(this.cache)
  }

  save(patch: ConfigPatch): AppConfig {
    const validated = configPatchSchema.parse(patch)
    const previous = this.load()
    const next = normalizeConfig(mergeConfig(previous, validated))
    for (const [field, flag] of [['audioDevice', 'audioDeviceMigrated'], ['audioOutputDevice', 'audioOutputDeviceMigrated']] as const) {
      if (validated.asr && Object.hasOwn(validated.asr, field)) next.asr[flag] = false
    }
    const persisted = structuredClone(next) as AppConfig & { asr: AppConfig['asr'] & { apiKeyEncrypted?: string } }
    let cipher = this.encryptedKey
    if (next.asr.apiKey) {
      if (!this.secrets?.available()) throw new Error('系统密钥服务不可用，接口密钥未保存，请稍后重试')
      cipher = this.secrets.encrypt(next.asr.apiKey)
    } else if (validated.asr && Object.hasOwn(validated.asr, 'apiKey')) {
      cipher = undefined
    }
    persisted.asr.apiKey = ''
    if (cipher) persisted.asr.apiKeyEncrypted = cipher
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temporary = this.file + '.tmp'
    try {
      fs.writeFileSync(temporary, JSON.stringify(persisted, null, 2), { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(temporary, this.file)
    } catch (error) {
      try { fs.unlinkSync(temporary) } catch { /* best effort */ }
      throw new Error('配置保存失败：' + String(error))
    }
    // Publish only after a successful atomic write; do not claim a failed save succeeded.
    this.cache = next
    this.encryptedKey = cipher
    return structuredClone(next)
  }

  defaults(): AppConfig { return structuredClone(DEFAULTS) }
}
