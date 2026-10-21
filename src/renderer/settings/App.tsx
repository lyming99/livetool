import { memo, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { SettingsModel, STATE_TEXT } from './model/settings-model'
import { AppearancePanel, BehaviourPanel, DisplayPanel, PreviewPanel } from './components/panels'
import { AudioPanel } from './components/AudioPanel'
import { EnginePanel } from './components/EnginePanel'
import { RecordingPanel } from './components/RecordingPanel'

// ASR partials and level-meter events must not re-render every settings control.
const Appearance = memo(AppearancePanel, (a, b) => a.config === b.config)
const Audio = memo(AudioPanel, (a, b) => a.config === b.config && a.state.devices === b.state.devices && a.state.outputs === b.state.outputs && a.state.diagnostics === b.state.diagnostics && a.state.status.running === b.state.status.running && a.state.captureHint === b.state.captureHint)
const Display = memo(DisplayPanel, (a, b) => a.config === b.config && a.state.displays === b.state.displays && a.state.refreshing === b.state.refreshing && a.state.displayHint === b.state.displayHint)
const Behaviour = memo(BehaviourPanel, (a, b) => a.config === b.config && a.state.status.clickThrough === b.state.status.clickThrough && a.state.status.overlayVisible === b.state.status.overlayVisible)
const Preview = memo(PreviewPanel, (a, b) => a.state.previewHint === b.state.previewHint)
const Recording = memo(RecordingPanel, (a, b) => a.config === b.config && a.state.status.session === b.state.status.session && a.state.status.running === b.state.status.running)
const Engine = memo(EnginePanel, (a, b) => a.config === b.config && a.state.status.packaged === b.state.status.packaged && a.state.environment === b.state.environment && a.state.installLines === b.state.installLines && a.state.installing === b.state.installing && a.state.reloading === b.state.reloading && a.state.diagnostics.phase === b.state.diagnostics.phase && a.state.diagnostics.micTesting === b.state.diagnostics.micTesting)

export function App(): ReactNode {
  const [model] = useState(() => new SettingsModel(window.settingsAPI))
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot)
  useEffect(() => {
    const disconnect = model.connect()
    const unload = (): void => { disconnect(); model.dispose() }
    window.addEventListener('beforeunload', unload)
    return () => { disconnect(); window.removeEventListener('beforeunload', unload) }
  }, [model])
  if (!state.config) return <div className="app"><div className="meta" role="status">{state.error || '正在读取设置…'}</div></div>
  const config = state.config
  const status = state.status
  const engine = status.engine.state
  const props = { config, model, state }
  const restarting = engine === 'restarting'
  const badge = engine === 'running' ? 'ok' : engine === 'error' ? 'err' : ['starting', 'loading', 'stopping', 'restarting'].includes(engine) ? 'warn' : ''
  return <div className="app">
    <header className="topbar"><div className="title"><h1>实时字幕</h1><span className={'badge ' + badge} id="engineBadge">{STATE_TEXT[engine] || engine}</span></div>
      <div className="actions"><button id="btnToggle" className="primary" disabled={model.diagnostics.busy || engine === 'stopping'} onClick={() => void model.run(() => model.toggle())}>{restarting ? '自动重启中…' : status.running ? '停止识别' : '开始识别'}</button><button id="btnLock" onClick={() => void model.run(() => model.lock(!status.clickThrough))}>{status.clickThrough ? '解锁字幕' : '锁定字幕'}</button></div>
    </header>
    <div className="meta" id="metaText">引擎：{STATE_TEXT[engine] || engine}{status.engine.detail ? ' · ' + status.engine.detail : ''} · Python PID：{status.pythonPid ?? '—'} · {status.mock ? '模拟数据（--mock）' : '真实识别'}</div>
    {state.error && <div className="error-banner" role="alert" id="appError">{state.error}</div>}
    <main className="content">
      <section className="card"><h2>当前字幕</h2><div className="preview" id="preview">{!state.subtitle.final && !state.subtitle.partial ? '（等待识别…）' : <>{state.subtitle.final}{state.subtitle.partial && <span className="draft">{state.subtitle.partial}</span>}</>}</div></section>
      <Appearance {...props} /><Audio {...props} /><Recording {...props} /><Display {...props} /><Behaviour {...props} /><Preview {...props} /><Engine {...props} />
    </main>
    <footer className="footer"><button id="btnReset" onClick={() => void model.run(() => model.reset())}>恢复默认</button><button id="btnQuit" className="danger" onClick={() => void model.run(() => model.quit())}>退出程序</button></footer>
  </div>
}
