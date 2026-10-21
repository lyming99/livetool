import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Engine } from '../../../shared/config'
import type { PanelProps } from './panels'
import { Field, NumberField, SelectField, Switch, TextField } from './fields'

const groups = [
  { label: 'OpenAI', models: [['whisper-1', 'whisper-1（通用转写）'], ['gpt-4o-transcribe', 'gpt-4o-transcribe（更准）'], ['gpt-4o-mini-transcribe', 'gpt-4o-mini-transcribe（更快更省）']] },
  { label: '硅基流动 / 兼容网关', models: [['FunAudioLLM/SenseVoiceSmall', 'FunAudioLLM/SenseVoiceSmall'], ['FunAudioLLM/SenseVoiceLarge', 'FunAudioLLM/SenseVoiceLarge']] },
  { label: '本地 whisper 服务', models: [['whisper-large-v3', 'whisper-large-v3'], ['whisper-small', 'whisper-small'], ['whisper-base', 'whisper-base']] }
]
const presets = groups.flatMap(group => group.models.map(item => item[0]))
export function EnginePanel({ config, model, state }: PanelProps): ReactNode {
  const asr = config.asr
  const api = asr.engine === 'api'
  const [custom, setCustom] = useState(false)
  const modelInput = useRef<HTMLInputElement>(null)
  const log = useRef<HTMLPreElement>(null)
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight }, [state.installLines])
  const modelHint = !asr.apiModel.trim() ? '模型名不能为空；留空会按 whisper-1 处理。' : presets.includes(asr.apiModel) ? `当前使用预设模型 ${asr.apiModel}；也可以直接在「接口模型」里改成接口支持的其他模型名。` : `当前使用自定义模型 ${asr.apiModel}；想换回预设可在上方「常用模型」里选。`
  return <section className="card"><h2>识别引擎</h2>
    <div className="hint-line" id="engineNote">{state.status.packaged ? '安装版内置 FunASR 和 Whisper 两个本地引擎（首次使用需要下载对应模型）；也可以选「接口（云端 API）」，本地只做采集，不下载模型。' : '源码模式：FunASR、Whisper 两个本地引擎，以及接口（云端 API）都可以用。'}</div>
    <SelectField id="asrEngine" label="引擎" value={asr.engine} options={[[ 'funasr', 'FunASR（中文流式，推荐）' ], [ 'whisper', 'Whisper（本地多语种）' ], [ 'api', '接口（云端 API）' ]]} onChange={value => {
      const engine = value as Engine
      model.edit({ asr: { engine } }); void model.run(() => model.checkEnvironment(engine))
    }} />
    <div className={'engine-block' + (asr.engine === 'funasr' ? ' active' : '')} data-engine="funasr">
      <TextField id="asrModel" label="模型名称" value={asr.model} placeholder="paraformer-zh-streaming" onChange={value => model.edit({ asr: { model: value } })} />
      <TextField id="asrModelRevision" label="模型版本" value={asr.modelRevision} placeholder="v2.0.4" onChange={value => model.edit({ asr: { modelRevision: value } })} />
      <TextField id="asrPuncModel" label="标点模型" value={asr.puncModel} placeholder="ct-punc" onChange={value => model.edit({ asr: { puncModel: value } })} />
      <Switch id="asrUsePunc" label="启用标点恢复（关闭可省内存）" checked={asr.usePunc} onChange={usePunc => model.edit({ asr: { usePunc } })} />
    </div>
    <div className={'engine-block' + (asr.engine === 'whisper' ? ' active' : '')} data-engine="whisper">
      <SelectField id="whisperModel" label="模型规格" value={asr.whisperModel} options={[[ 'tiny', 'tiny（最快，准确率低）' ], [ 'base', 'base' ], [ 'small', 'small（推荐）' ], [ 'medium', 'medium（更准但更慢）' ], [ 'large-v3', 'large-v3（最准，很慢）' ]]} onChange={whisperModel => model.edit({ asr: { whisperModel } })} />
      <SelectField id="computeType" label="计算精度" value={asr.computeType} options={[[ 'int8', 'int8（省内存，CPU 推荐）' ], [ 'float16', 'float16（需要 GPU）' ], [ 'float32', 'float32（最慢）' ]]} onChange={computeType => model.edit({ asr: { computeType } })} />
      <SelectField id="language" label="识别语言" value={asr.language} options={[[ 'zh', '中文' ], [ 'en', '英文' ], [ 'auto', '自动检测' ]]} onChange={language => model.edit({ asr: { language } })} />
    </div>
    <div className={'engine-block' + (api ? ' active' : '')} data-engine="api">
      <TextField id="apiBaseUrl" label="接口地址" value={asr.apiBaseUrl} placeholder="https://api.openai.com/v1" onChange={apiBaseUrl => model.edit({ asr: { apiBaseUrl } })} />
      <TextField id="apiKey" label="接口密钥" password value={asr.apiKey} placeholder="sk-...（自建接口可留空）" onChange={apiKey => model.edit({ asr: { apiKey } })} />
      <Field id="apiModelPreset" label="常用模型"><select id="apiModelPreset" value={!custom && presets.includes(asr.apiModel) ? asr.apiModel : '__custom__'} onChange={event => {
        if (event.target.value === '__custom__') { setCustom(true); modelInput.current?.focus(); modelInput.current?.select() }
        else { setCustom(false); model.edit({ asr: { apiModel: event.target.value } }) }
      }}>{groups.map(group => <optgroup key={group.label} label={group.label}>{group.models.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</optgroup>)}<option value="__custom__">自定义模型名…</option></select></Field>
      <TextField id="apiModel" label="接口模型" inputRef={modelInput} value={asr.apiModel} placeholder="whisper-1" onChange={apiModel => { setCustom(false); model.edit({ asr: { apiModel } }) }} />
      <div className="hint-line" id="apiModelHint">{modelHint}</div>
      <SelectField id="apiLanguage" label="接口语言" value={asr.apiLanguage || asr.language || 'zh'} options={[[ 'zh', '中文' ], [ 'en', '英文' ], [ 'auto', '自动检测' ]]} onChange={apiLanguage => model.edit({ asr: { apiLanguage } })} />
      <TextField id="apiPrompt" label="提示词" value={asr.apiPrompt} placeholder="可选：专有名词，帮助识别" onChange={apiPrompt => model.edit({ asr: { apiPrompt } })} />
      <NumberField id="apiTimeout" label="请求超时" value={asr.apiTimeout} min={5} max={120} unit="秒" onChange={apiTimeout => model.edit({ asr: { apiTimeout } })} />
      <div className="hint-line" id="apiHint">本地只做音频采集，按句调用 OpenAI 兼容的 /audio/transcriptions 接口转写；音频不落盘，密钥使用系统加密后保存在本机。</div>
    </div>
    <SelectField id="asrDevice" label="推理设备" value={asr.device} options={[[ 'cpu', 'CPU' ], [ 'cuda:0', 'GPU (cuda:0)' ]]} onChange={device => model.edit({ asr: { device } })} />
    <TextField id="asrModelPath" label="本地模型目录" value={asr.modelPath} placeholder="留空则自动下载" onChange={modelPath => model.edit({ asr: { modelPath } })} />
    <TextField id="asrCacheDir" label="模型缓存目录" value={asr.cacheDir} placeholder="留空则用默认缓存" onChange={cacheDir => model.edit({ asr: { cacheDir } })} />
    <div className="env-box" id="envBox">{!state.environment ? '点「检查环境」查看依赖状态' : !state.environment.deps?.length ? state.environment.error || '暂无环境信息' : <>{state.environment.deps.map(dependency => <div key={dependency.package} className={dependency.installed ? 'ok' : 'bad'}>{dependency.installed ? '✓ 已安装' : '✗ 未安装'}  {dependency.package}</div>)}<div>{state.environment.ready ? '依赖齐全，可以直接开始识别' : '还缺依赖，点「一键安装 / 下载模型」补齐'}</div></>}</div>
    <div className="row-actions"><button id="btnCheckEnv" className="mini" onClick={() => void model.run(() => model.checkEnvironment(asr.engine))}>检查环境</button><button id="btnInstall" className="mini primary" disabled={state.installing} onClick={() => void model.run(() => model.install(asr.engine))}>{api ? '校验接口配置' : '一键安装 / 下载模型'}</button><button id="btnReloadModel" className="mini" disabled={state.reloading || model.diagnostics.busy} onClick={() => void model.run(() => model.reload())}>{state.reloading ? '正在重新加载…' : '重新加载模型'}</button></div>
    <pre className={'install-log' + (state.installLines.length ? ' show' : '')} id="installLog" ref={log}>{state.installLines.join('\n')}</pre>
    <div className="hint-line" id="installHint">{api ? '接口模式不用下载模型：填好接口地址、密钥和模型名后，直接点「开始识别」即可；改完配置点「重新加载模型」生效。' : '首次使用先点「一键安装」补齐依赖并下载模型；改完配置后点「重新加载模型」生效。'}</div>
  </section>
}
