import { z } from 'zod'
import type { AppConfig, ConfigPatch, Engine } from './config'

export type Unsubscribe = () => void
export interface SubtitleState { final: string; partial: string }
export interface EngineStatus { state: string; detail: string }
export interface AudioDevice { id: string; name: string; default?: boolean; api?: string }
export interface DisplayInfo {
  id: number; label: string; displayKey: string; width: number; height: number;
  workWidth: number; workHeight: number; x: number; y: number; scaleFactor: number; rotation: number; primary: boolean
}
export interface SessionStatus {
  active: boolean; directory: string | null; subtitlePath: string | null;
  segments: number; cues: number; durationSeconds: number; detail: string
}
export interface AppStatus {
  running: boolean; recording: boolean; micTesting: boolean; recognizing: boolean;
  recordingPath: string | null; referenceAvailable: boolean; clickThrough: boolean; overlayVisible: boolean;
  engine: EngineStatus; pythonPid: number | null; mock: boolean; packaged: boolean; session: SessionStatus
}
export interface RecordResult {
  ok: boolean; detail?: string; path?: string; duration?: number; sampleRate?: number; channels?: number;
  peak?: number; rms?: number; captureSource?: string; deviceName?: string;
  discontinuities?: number; streamTicks?: number; overflows?: number; clipped?: number
}
export interface RecordLevel { level: number; elapsed: number; duration: number }
export interface RecognizeResult { ok: boolean; detail?: string; text?: string; duration?: number; loadSeconds?: number; inferSeconds?: number }
export interface CaptureSwitch { ok: boolean; applied?: boolean; switched?: boolean; kind?: string; label?: string; detail?: string }
export interface EnvironmentState { ready?: boolean; error?: string; deps?: { package: string; installed: boolean }[] }
export interface InstallProgress { phase: string; engine?: string; message?: string; ok?: boolean }

/** Additive JSONL protocol: Python remains the owner of model/capture implementation. */
export const backendEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('partial'), text: z.string(), ts: z.number().optional() }),
  z.object({ type: z.literal('final'), text: z.string(), ts: z.number().optional() }),
  z.object({ type: z.literal('status'), state: z.string(), detail: z.string().optional() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('devices'), inputs: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()), outputs: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()).optional() }),
  z.object({ type: z.literal('record_result'), ok: z.boolean() }).passthrough(),
  z.object({ type: z.literal('record_level'), level: z.number(), elapsed: z.number(), duration: z.number() }).passthrough(),
  z.object({ type: z.literal('recognize_result'), ok: z.boolean() }).passthrough(),
  z.object({ type: z.literal('capture_switch'), ok: z.boolean() }).passthrough(),
  z.object({ type: z.literal('session'), state: z.string() }).passthrough(),
  z.object({ type: z.literal('mic_test') }).passthrough(),
  z.object({ type: z.literal('env') }).passthrough(),
  z.object({ type: z.literal('install'), phase: z.string() }).passthrough(),
  z.object({ type: z.literal('log') }).passthrough()
])
export type BackendEvent = z.infer<typeof backendEventSchema>
export type BackendCommand = { type: 'start' | 'stop' | 'shutdown' | 'list_devices' | 'check_env' | 'record_test' | 'stop_record' | 'recognize_test' | 'mic_test' | 'install' | 'switch_capture' | 'set_record'; asr?: AppConfig['asr']; engine?: Engine; seconds?: number; enabled?: boolean }

export interface SettingsAPI {
  getConfig(): Promise<AppConfig>; setConfig(patch: ConfigPatch): Promise<AppConfig>; getDefaults(): Promise<AppConfig>;
  getStatus(): Promise<AppStatus>; getDisplays(): Promise<DisplayInfo[]>; refreshDisplays(): Promise<DisplayInfo[]>;
  previewText(text: string): Promise<string>; getAudioDevices(): Promise<boolean>; checkEnv(engine: Engine): Promise<boolean>;
  testMic(): Promise<boolean>; testRecord(seconds: number): Promise<boolean>; testRecognize(): Promise<boolean>;
  readRecording(kind?: 'current' | 'reference'): Promise<string | null>; runInstall(engine: Engine): Promise<boolean>;
  chooseRecordingDir(): Promise<string | null>; openRecordingDir(): Promise<boolean>;
  setClickThrough(value: boolean): Promise<boolean>; setOverlayVisible(value: boolean): Promise<boolean>;
  toggleEngine(): Promise<boolean>; reloadEngine(): Promise<boolean>; quit(): Promise<void>;
  onConfig(cb: (value: AppConfig) => void): Unsubscribe; onSubtitle(cb: (value: SubtitleState) => void): Unsubscribe;
  onStatus(cb: (value: EngineStatus) => void): Unsubscribe; onDisplaysChanged(cb: (value: DisplayInfo[]) => void): Unsubscribe;
  onOverlayVisible(cb: (value: boolean) => void): Unsubscribe; onAudioDevices(cb: (value: AudioDevice[]) => void): Unsubscribe;
  onAudioOutputDevices(cb: (value: AudioDevice[]) => void): Unsubscribe; onCaptureSwitch(cb: (value: CaptureSwitch) => void): Unsubscribe;
  onMicTest(cb: (value: unknown) => void): Unsubscribe; onRecordResult(cb: (value: RecordResult) => void): Unsubscribe;
  onRecordLevel(cb: (value: RecordLevel) => void): Unsubscribe; onRecognizeResult(cb: (value: RecognizeResult) => void): Unsubscribe;
  onEnvState(cb: (value: EnvironmentState) => void): Unsubscribe; onInstallProgress(cb: (value: InstallProgress) => void): Unsubscribe;
  onSession(cb: (value: SessionStatus) => void): Unsubscribe
}
export interface OverlayAPI {
  onSubtitle(cb: (value: SubtitleState) => void): Unsubscribe; onPreview(cb: (text: string) => void): Unsubscribe;
  onMetrics(cb: () => void): Unsubscribe; onConfig(cb: (value: AppConfig) => void): Unsubscribe;
  onStatus(cb: (value: EngineStatus) => void): Unsubscribe; getConfig(): Promise<AppConfig>;
  setConfig(patch: Pick<ConfigPatch, 'anchorX' | 'offsetY'>): Promise<AppConfig>;
  setClickThrough(value: boolean): Promise<boolean>; openSettings(): Promise<void>
}

declare global { interface Window { settingsAPI: SettingsAPI; overlayAPI: OverlayAPI } }
