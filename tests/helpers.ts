import { vi } from 'vitest'
import { DEFAULTS, mergeConfig, type AppConfig } from '../src/shared/config'
import type { AppStatus, SettingsAPI } from '../src/shared/contracts'

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export function status(patch: Partial<AppStatus> = {}): AppStatus {
  return { running: false, recording: false, micTesting: false, recognizing: false, recordingPath: null,
    referenceAvailable: false, clickThrough: true, overlayVisible: true, engine: { state: 'idle', detail: '' },
    pythonPid: null, mock: true, packaged: false,
    session: { active: false, directory: null, subtitlePath: null, segments: 0, cues: 0, durationSeconds: 0, detail: '' },
    ...patch }
}
export function apiFixture() {
  let config: AppConfig = structuredClone(DEFAULTS)
  const events = new Map<string, Set<(value: unknown) => void>>()
  const event = <T>(name: string) => (callback: (value: T) => void) => {
    const callbacks = events.get(name) ?? new Set()
    events.set(name, callbacks); callbacks.add(callback as (value: unknown) => void)
    return () => { callbacks.delete(callback as (value: unknown) => void) }
  }
  const api: SettingsAPI = {
    getConfig: vi.fn(async () => structuredClone(config)),
    setConfig: vi.fn(async patch => { config = mergeConfig(config, patch); return structuredClone(config) }),
    getDefaults: vi.fn(async () => structuredClone(DEFAULTS)), getStatus: vi.fn(async () => status()),
    getDisplays: vi.fn(async () => []), refreshDisplays: vi.fn(async () => []),
    previewText: vi.fn(async text => text), getAudioDevices: vi.fn(async () => true), checkEnv: vi.fn(async () => true),
    testMic: vi.fn(async () => true), testRecord: vi.fn(async () => true), testRecognize: vi.fn(async () => true),
    readRecording: vi.fn(async () => Buffer.from('RIFF fake wav data').toString('base64')),
    runInstall: vi.fn(async () => true), setClickThrough: vi.fn(async value => value), setOverlayVisible: vi.fn(async value => value),
    chooseRecordingDir: vi.fn(async () => 'D:\\recordings'), openRecordingDir: vi.fn(async () => true),
    toggleEngine: vi.fn(async () => true), reloadEngine: vi.fn(async () => true), quit: vi.fn(async () => {}),
    onConfig: event('Config'), onSubtitle: event('Subtitle'), onStatus: event('Status'),
    onDisplaysChanged: event('DisplaysChanged'), onOverlayVisible: event('OverlayVisible'),
    onAudioDevices: event('AudioDevices'), onAudioOutputDevices: event('AudioOutputDevices'),
    onCaptureSwitch: event('CaptureSwitch'), onMicTest: event('MicTest'), onRecordResult: event('RecordResult'),
    onRecordLevel: event('RecordLevel'), onRecognizeResult: event('RecognizeResult'), onEnvState: event('EnvState'),
    onInstallProgress: event('InstallProgress'), onSession: event('Session')
  }
  return { api, config: () => config, emit: (name: string, value: unknown) => events.get(name)?.forEach(callback => callback(value)), count: () => [...events.values()].reduce((sum, callbacks) => sum + callbacks.size, 0) }
}
