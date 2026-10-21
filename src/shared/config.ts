import { z } from 'zod'
import defaults from './defaults.json'

export const engineSchema = z.enum(['funasr', 'whisper', 'api'])
export const asrSchema = z.object({
  engine: engineSchema,
  model: z.string(), modelRevision: z.string(), modelPath: z.string(),
  puncModel: z.string(), usePunc: z.boolean(), device: z.string(),
  audioDevice: z.string().nullable(), captureSource: z.enum(['input', 'output']),
  audioOutputDevice: z.string().nullable(), cacheDir: z.string(),
  whisperModel: z.string(), computeType: z.string(), language: z.string(),
  apiBaseUrl: z.string(), apiKey: z.string(), apiModel: z.string(),
  apiLanguage: z.string(), apiPrompt: z.string(), apiTimeout: z.number().finite(),
  audioDeviceMigrated: z.boolean().optional(), audioOutputDeviceMigrated: z.boolean().optional()
})
export const configSchema = z.object({
  fontFamily: z.string(), fontSize: z.number().finite(), fontWeight: z.number().finite(),
  color: z.string(), strokeColor: z.string(), strokeWidth: z.number().finite(), lineGap: z.number().finite(),
  displayId: z.number().nullable(), displayLabel: z.string().nullable(), position: z.enum(['bottom', 'top']),
  anchorX: z.number().finite(), offsetY: z.number().finite(), widthRatio: z.number().finite(),
  maxLines: z.number().finite(), opacity: z.number().finite(), showPartial: z.boolean(),
  clickThrough: z.boolean(), autoHideDelay: z.number().finite(), subtitleMode: z.enum(['realtime', 'sentence']),
  sentenceDelay: z.number().finite(), asr: asrSchema
})
export const configPatchSchema = configSchema.omit({ asr: true }).partial().extend({ asr: asrSchema.partial().strict().optional() }).strict()
export type AsrConfig = z.infer<typeof asrSchema>
export type AppConfig = z.infer<typeof configSchema>
export type ConfigPatch = z.infer<typeof configPatchSchema>
export type Engine = AsrConfig['engine']

export const DEFAULTS: AppConfig = configSchema.parse(defaults)

export function mergeConfig(config: AppConfig, patch: ConfigPatch): AppConfig {
  return { ...config, ...patch, asr: { ...config.asr, ...patch.asr } }
}

/** Persisted old versions are normalized once; new IPC patches are validated separately. */
export function normalizeConfig(saved: unknown): AppConfig {
  const input = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {}
  const oldAsr = input.asr && typeof input.asr === 'object' ? input.asr as Record<string, unknown> : {}
  const next = structuredClone(DEFAULTS)
  for (const key of Object.keys(configSchema.shape) as (keyof AppConfig)[]) {
    if (key === 'asr') continue
    const schema = configSchema.shape[key]
    const parsed = schema.safeParse(input[key])
    if (parsed.success) Object.assign(next, { [key]: parsed.data })
  }
  for (const key of Object.keys(asrSchema.shape) as (keyof AsrConfig)[]) {
    const parsed = asrSchema.shape[key].safeParse(oldAsr[key])
    if (parsed.success && parsed.data !== undefined) Object.assign(next.asr, { [key]: parsed.data })
  }
  for (const key of ['audioDevice', 'audioOutputDevice'] as const) {
    if (typeof oldAsr[key] === 'number') {
      next.asr[key] = null
      next.asr[key === 'audioDevice' ? 'audioDeviceMigrated' : 'audioOutputDeviceMigrated'] = true
    }
  }
  next.anchorX = clamp(next.anchorX, 0, 1)
  next.opacity = clamp(next.opacity, 0, 1)
  next.widthRatio = clamp(next.widthRatio, 0.1, 1)
  next.autoHideDelay = Math.round(clamp(next.autoHideDelay, 0, 3600))
  next.sentenceDelay = Math.round(clamp(next.sentenceDelay, 0, 10000))
  next.fontSize = clamp(next.fontSize, 8, 200)
  next.fontWeight = clamp(next.fontWeight, 100, 1000)
  next.strokeWidth = clamp(next.strokeWidth, 0, 50)
  next.lineGap = clamp(next.lineGap, 0, 100)
  next.maxLines = Math.round(clamp(next.maxLines, 1, 20))
  next.offsetY = clamp(next.offsetY, 0, 10000)
  next.asr.apiTimeout = Math.round(clamp(next.asr.apiTimeout, 5, 120))
  for (const key of ['apiBaseUrl', 'apiKey', 'apiModel', 'apiLanguage', 'apiPrompt'] as const) next.asr[key] = next.asr[key].trim()
  if (!next.asr.apiModel) next.asr.apiModel = 'whisper-1'
  for (const key of ['audioDevice', 'audioOutputDevice'] as const) if (next.asr[key] !== null && !next.asr[key]?.trim()) next.asr[key] = null
  return next
}
export function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)) }

export function overlayConfig(config: AppConfig): AppConfig {
  return { ...config, asr: { ...config.asr, apiKey: '' } }
}
