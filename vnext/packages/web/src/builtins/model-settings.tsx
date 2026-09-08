import { useEffect, useState } from 'react'
import { Bot, Box, Check, Eye, EyeOff, Pencil, PlugZap, Plus, RefreshCw, Star, Trash2 } from 'lucide-react'
import type { Context } from '@deepseek-ai/cordis'
import type { ManagedModel, ProfileInfo, ProfileUpdate } from '@morrow/sdk'
import type { PanelProps } from '../plugins.js'
import { MiniIconButton } from '../IconButton.js'
import { Select } from '../Select.js'
import { baseUrl, modelWindow, request, type Configuration } from './model-configuration.js'
import { ModelPicker } from './model-picker.js'

type Draft = { id: string; name: string; provider: string; baseUrl: string; apiKey: string; enabled: boolean; models: ManagedModel[]; model: string; options: string; preset?: string; legacyEndpoint?: string }
const emptyModel = (): ManagedModel => ({ id: '', name: '', contextWindow: 0, vision: false })
const newDraft = (): Draft => ({ id: crypto.randomUUID(), name: '新供应商', provider: 'openai-chat', baseUrl: '', apiKey: '', enabled: true, models: [], model: '', options: '{}' })

function ModelSettings({ invoke }: PanelProps) {
  const [config, setConfig] = useState<Configuration>()
  const [draft, setDraft] = useState<Draft>()
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [revealed, setRevealed] = useState('')
  const [editingModel, setEditingModel] = useState<number | null>(null)
  const [modelDraft, setModelDraft] = useState<ManagedModel>(emptyModel)
  const [attempt, setAttempt] = useState(0)
  const select = (profile: ProfileInfo | undefined, value: Configuration) => {
    const base = profile && baseUrl(profile, value.formats)
    setDraft(profile ? { id: profile.id, name: profile.name, provider: profile.provider, baseUrl: base!, enabled: profile.enabled, models: profile.models, model: profile.model, apiKey: '', options: JSON.stringify(profile.options, null, 2), preset: profile.preset,
      // Preserve old custom endpoints until the URL or protocol is edited.
      legacyEndpoint: profile.baseUrl === undefined && base === profile.endpoint ? profile.endpoint : undefined } : undefined)
    setDirty(false); setShowKey(false); setRevealed(''); setRenaming(false); setDeleting(false); setEditingModel(null)
  }
  const reload = async () => { const value = await request<Configuration>(invoke, 'profiles.get'); setConfig(value); return value }
  useEffect(() => {
    let disposed = false
    void request<Configuration>(invoke, 'profiles.get').then(value => {
      if (disposed) return
      setConfig(value); select(value.profiles.find(profile => profile.id === value.defaultId) ?? value.profiles[0], value); setError('')
    }).catch(error => { if (!disposed) setError(String(error.message ?? error)) })
    return () => { disposed = true }
  }, [invoke, attempt])
  const change = (patch: Partial<Draft>) => { setDraft(value => value && { ...value, ...patch }); setDirty(true); setStatus(''); setError('') }
  const work = async (task: () => Promise<void>) => {
    setBusy(true); setError(''); setStatus('')
    try { await task() } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const persist = async (value = draft, makeDefault = false) => {
    if (!value) throw new Error('请先添加供应商')
    let options: unknown
    try { options = JSON.parse(value.options) } catch { throw new Error('默认请求参数不是有效的 JSON') }
    if (!options || Array.isArray(options) || typeof options !== 'object') throw new Error('默认请求参数必须是 JSON 对象')
    const update: ProfileUpdate = { id: value.id, name: value.name, provider: value.provider, enabled: value.enabled, models: value.models, model: value.model, apiKey: value.apiKey, options: options as Record<string, unknown>, preset: value.preset, makeDefault,
      ...(value.legacyEndpoint && value.baseUrl === value.legacyEndpoint ? { endpoint: value.legacyEndpoint } : { baseUrl: value.baseUrl }) }
    await request(invoke, 'profiles.save', update)
    const next = await reload(); select(next.profiles.find(profile => profile.id === value.id), next)
    return next
  }
  const switchTo = (profile?: ProfileInfo) => void work(async () => {
    if (editingModel !== null) throw new Error('请先完成或取消正在编辑的模型')
    const next = dirty ? await persist() : config!
    if (profile) select(next.profiles.find(value => value.id === profile.id), next)
    else { select(undefined, next); setDraft(newDraft()); setDirty(true); setRenaming(true) }
  })
  const finishModel = () => {
    if (!draft || editingModel === null) return
    if (!modelDraft.id.trim()) { setError('请填写模型 ID'); return }
    if (draft.models.some((model, index) => index !== editingModel && model.id === modelDraft.id.trim())) { setError('这个模型 ID 已存在'); return }
    if (!Number.isSafeInteger(modelDraft.contextWindow) || modelDraft.contextWindow < 0) { setError('上下文窗口必须是非负整数'); return }
    const model = { ...modelDraft, id: modelDraft.id.trim(), name: modelDraft.name.trim() || modelDraft.id.trim() }
    const models = [...draft.models]; models[editingModel] = model
    change({ models, model: !draft.model || draft.model === draft.models[editingModel]?.id ? model.id : draft.model })
    setEditingModel(null)
  }
  const revealKey = () => void work(async () => {
    if (showKey) { setShowKey(false); setRevealed(''); return }
    if (!draft?.apiKey && draft) setRevealed((await request<{ apiKey: string }>(invoke, 'profiles.reveal', { id: draft.id })).apiKey)
    setShowKey(true)
  })
  if (!config) return <section className="settings-card extension-card">{error ? <><p role="alert">{error}</p><button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重新加载</button></> : <p>正在加载模型设置…</p>}</section>
  const saved = config.profiles.find(profile => profile.id === draft?.id)
  const formats = config.formats.filter(format => format.id !== 'openai' || draft?.provider === 'openai')
  if (draft && !formats.some(format => format.id === draft.provider)) formats.push({ id: draft.provider, label: `${draft.provider} · 未加载`, requestPath: '' })
  const path = formats.find(format => format.id === draft?.provider)?.requestPath
  const providerItem = (profile: ProfileInfo) => <button key={profile.id} type="button" className={`model-provider-item${draft?.id === profile.id ? ' active' : ''}`} aria-label={`供应商 ${profile.name}`} aria-pressed={draft?.id === profile.id} disabled={busy} onClick={() => switchTo(profile)}>
    <Box size={16} /><span><strong>{profile.name}</strong></span><i className={profile.enabled ? 'ready' : 'disabled'} title={profile.enabled ? '已启用' : '已禁用'} />
  </button>
  return <section className="supplier-settings">
    <div className="supplier-intro"><p className="muted-line">管理模型供应商，配置后可在聊天时选择模型。</p><MiniIconButton title="刷新配置" disabled={busy} onClick={() => void work(async () => {
      if (editingModel !== null) throw new Error('请先完成或取消正在编辑的模型')
      const next = dirty ? await persist() : await reload(); select(next.profiles.find(profile => profile.id === draft?.id) ?? next.profiles[0], next)
    })}><RefreshCw size={15} /></MiniIconButton></div>
    {error && <p className="session-status-banner error" role="alert">{error}</p>}
    {status && <p className="supplier-status" role="status">{status}</p>}
    <div className="model-settings-shell">
      <aside className="model-provider-list" aria-label="模型供应商">
        <div className="model-provider-scroll">
          <p className="supplier-group">自定义供应商</p>
          {config.profiles.map(providerItem)}
          {draft && !saved && <button type="button" className="model-provider-item active" aria-current="true"><Box size={16} /><span><strong>{draft.name}</strong><small>未保存</small></span></button>}
          <button className="supplier-add" type="button" disabled={busy} onClick={() => switchTo()}><Plus size={15} />添加供应商</button>
        </div>
      </aside>
      <div className="model-provider-editor">
        {draft ? <form className="supplier-form" onSubmit={event => { event.preventDefault(); if (editingModel !== null) { finishModel(); return }; void work(async () => { await persist(); setStatus('供应商已保存，后续请求立即生效') }) }}>
          <div className="supplier-title">
            {renaming ? <input className="supplier-name" aria-label="供应商名称" autoFocus value={draft.name} maxLength={128} onChange={event => change({ name: event.target.value })} onBlur={() => setRenaming(false)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); setRenaming(false) } }} /> : <><h2>{draft.name}</h2><MiniIconButton title="重命名供应商" disabled={busy} onClick={() => setRenaming(true)}><Pencil size={14} /></MiniIconButton></>}
            <span className={`supplier-badge${draft.enabled ? ' enabled' : ''}`}>{draft.enabled ? '已启用' : '已禁用'}</span>
            <button className="supplier-toggle" type="button" disabled={busy || editingModel !== null} onClick={() => saved ? void work(async () => { await persist({ ...draft, enabled: !draft.enabled }); setStatus(draft.enabled ? '供应商已禁用' : '供应商已启用') }) : change({ enabled: !draft.enabled })}>{draft.enabled ? '禁用' : '启用'}</button>
            <span className="supplier-title-space" /><MiniIconButton title="删除供应商" disabled={busy} onClick={() => setDeleting(true)}><Trash2 size={15} /></MiniIconButton>
          </div>
          {deleting && <div className="supplier-delete" role="alert"><span>删除「{draft.name}」及其模型配置？</span><button className="secondary-button" type="button" onClick={() => setDeleting(false)}>取消</button><button className="danger-button" type="button" disabled={busy} onClick={() => void work(async () => {
            if (saved) await request(invoke, 'profiles.remove', { id: draft.id })
            const next = await reload(); select(next.profiles.find(profile => profile.id === next.defaultId) ?? next.profiles[0], next); setStatus('供应商已删除')
          })}>确认删除</button></div>}
          <label className="extension-field">Base URL<input aria-label="Base URL" type="url" required disabled={busy} placeholder="https://api.example.com/v1" value={draft.baseUrl} onChange={event => change({ baseUrl: event.target.value, legacyEndpoint: undefined })} /></label>
          <Select label="API 格式" value={draft.provider} disabled={busy} options={formats.map(format => ({ value: format.id, label: `${format.label}${format.requestPath ? ` (${format.requestPath})` : ''}` }))} onChange={provider => change({ provider, legacyEndpoint: undefined })} />
          {path && !draft.legacyEndpoint && <p className="supplier-url-hint">请求时自动在 Base URL 后追加 <code>{path}</code>。</p>}
          <label className="extension-field">API Key<span className="supplier-key"><input aria-label="API Key" disabled={busy} type={showKey ? 'text' : 'password'} autoComplete="new-password" value={draft.apiKey || (showKey ? revealed : '')} placeholder={saved?.configured ? '••••••••••••••••••••••••' : '输入 API Key'} onChange={event => change({ apiKey: event.target.value })} /><MiniIconButton title={showKey ? '隐藏 API Key' : '显示 API Key'} disabled={busy || (!draft.apiKey && !saved?.configured)} onClick={revealKey}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</MiniIconButton></span></label>
          {saved?.configured && <p className="supplier-key-hint">已保存密钥，留空保留原值。</p>}
          <section className="supplier-models" aria-label="模型列表"><p className="supplier-label">模型列表</p>
            <div className="supplier-model-list">
              {draft.models.map((model, index) => <div className="supplier-model-row" key={index}>
                <div className="supplier-model-name"><span title={model.id}>{model.name || model.id}</span><div className="supplier-model-tags">{model.vision && <small>视觉</small>}{model.contextWindow > 0 && <small>{modelWindow(model.contextWindow)}</small>}{config.defaultId === draft.id && saved?.model === model.id && <small>默认</small>}</div></div>
                <MiniIconButton title={`测试连接 ${model.id}`} disabled={busy || editingModel !== null} onClick={() => void work(async () => {
                  if (dirty) await persist()
                  const result = await request<{ latencyMs: number }>(invoke, 'models.test', { id: draft.id, model: model.id }); setStatus(`${model.id} 连接正常 · ${result.latencyMs} ms`)
                })}><PlugZap size={14} /></MiniIconButton>
                <MiniIconButton title={`编辑模型 ${model.id}`} disabled={busy} onClick={() => { setEditingModel(index); setModelDraft({ ...model }); setError('') }}><Pencil size={14} /></MiniIconButton>
                <MiniIconButton title={`设为默认模型 ${model.id}`} disabled={busy || !draft.enabled || editingModel !== null} onClick={() => void work(async () => { await persist({ ...draft, model: model.id }, true); setStatus('默认模型已更新') })}><Star size={14} /></MiniIconButton>
                <MiniIconButton title={`删除模型 ${model.id}`} disabled={busy || editingModel !== null} onClick={() => { const models = draft.models.filter((_, i) => i !== index); change({ models, model: draft.model === model.id ? models[0]?.id ?? '' : draft.model }) }}><Trash2 size={14} /></MiniIconButton>
              </div>)}
              {!draft.models.length && <p className="supplier-empty-models">添加此供应商提供的模型。</p>}
            </div>
            {editingModel !== null ? <fieldset className="supplier-model-editor"><legend>{editingModel < draft.models.length ? '编辑模型' : '添加模型'}</legend>
              <label className="extension-field">模型 ID<input aria-label="模型 ID" value={modelDraft.id} onChange={event => setModelDraft(value => ({ ...value, id: event.target.value }))} placeholder="例如 glm-5.3-flash" /></label>
              <label className="extension-field">显示名称<input aria-label="模型显示名称" value={modelDraft.name} onChange={event => setModelDraft(value => ({ ...value, name: event.target.value }))} placeholder="留空使用模型 ID" /></label>
              <label className="extension-field">上下文窗口（tokens）<input aria-label="上下文窗口" type="number" min={0} max={100000000} step={1} value={modelDraft.contextWindow} onChange={event => setModelDraft(value => ({ ...value, contextWindow: Number(event.target.value) }))} /></label>
              <label className="profile-default"><input type="checkbox" checked={modelDraft.vision} onChange={event => setModelDraft(value => ({ ...value, vision: event.target.checked }))} />支持视觉输入</label>
              <div className="extension-actions"><button type="button" className="secondary-button" onClick={() => setEditingModel(null)}>取消</button><button type="button" className="approve-button" onClick={finishModel}><Check size={14} />完成</button></div>
            </fieldset> : <button className="supplier-add-model" type="button" disabled={busy} onClick={() => { setEditingModel(draft.models.length); setModelDraft(emptyModel()); setError('') }}><Plus size={14} />添加模型</button>}
          </section>
          <details className="supplier-parameters"><summary>默认请求参数</summary><label className="extension-field">JSON 参数<textarea aria-label="默认请求参数" value={draft.options} disabled={busy} onChange={event => change({ options: event.target.value })} rows={4} /></label></details>
          {dirty && <div className="supplier-save"><span>有未保存的更改</span><button type="button" className="secondary-button" disabled={busy} onClick={() => { select(saved ?? config.profiles[0], config); setError('') }}>取消更改</button><button className="approve-button" disabled={busy || editingModel !== null}>{busy ? '保存中…' : '保存更改'}</button></div>}
        </form> : <div className="model-settings-empty"><Bot size={30} /><p>添加一个供应商，开始配置模型。</p><button className="secondary-button" onClick={() => switchTo()}><Plus size={16} />添加供应商</button></div>}
      </div>
    </div>
  </section>
}

export default function modelSettings(ctx: Context) {
  ctx.ui.page('模型设置', ModelSettings, { order: 20, icon: <Bot size={18} />, shortcut: 'models' })
  ctx.ui.composer('模型选择', ModelPicker, { order: 20 })
}
