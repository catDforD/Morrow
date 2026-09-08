import { useEffect, useRef, useState } from 'react'
import { Bot, CheckCircle2, FileClock, Puzzle, Shield, X } from 'lucide-react'
import type { Approval, Projection, Record as FactRecord } from '@morrow/sdk'
import { api, base, sessionNames, snapshot } from './api.js'
import { IconButton, MiniIconButton } from './IconButton.js'
import { PluginView, type ClientView } from './plugins.js'
import { useDialogFocus } from './useDialogFocus.js'

export type InspectorTab = 'facts' | 'panels' | 'subagents'
const tabs = [
  { id: 'facts', label: '事实时间线', icon: <FileClock size={15} /> },
  { id: 'panels', label: '会话面板', icon: <Puzzle size={15} /> },
  { id: 'subagents', label: '子智能体', icon: <Bot size={15} /> },
] as const

export function Inspector({ session, state, records, views, tab, onTab, onClose, enabled, onEnable, report, onSession, onPlugins }: {
  session: string; state: Projection; records: FactRecord[]; views: ClientView[]; tab: InspectorTab
  onTab(tab: InspectorTab): void; onClose(): void; enabled: boolean; onEnable(): void; report(error: string): void
  onSession(session: string): void; onPlugins(): void
}) {
  const panel = useRef<HTMLElement>(null)
  const [request, setRequest] = useState<unknown>()
  useDialogFocus(panel, 'inspector', true)
  return <aside className="inspector-drawer open">
    <button className="drawer-backdrop" type="button" aria-label="关闭详情" onClick={onClose} />
    <section className="drawer-panel main-scroll" aria-label="执行详情" ref={panel} tabIndex={-1}>
      <header className="drawer-header"><h2>执行详情</h2><MiniIconButton title="关闭详情" onClick={onClose}><X size={18} /></MiniIconButton></header>
      <nav className="drawer-tabs vnext-drawer-tabs" aria-label="详情分类">{tabs.map(item => <button className={`drawer-tab${tab === item.id ? ' active' : ''}`} type="button" key={item.id} onClick={() => onTab(item.id)}>{item.icon}<span>{item.label}</span></button>)}</nav>
      <div className="drawer-run">
        {tab === 'facts' && <>
          <p className="muted-line">{records.length} 条事实 · 上下文版本 {state.revision}</p>
          {records.map(record => <details className="fact-record" key={record.seq}><summary>#{record.seq} · {record.fact.type}</summary><pre>{JSON.stringify(record.fact, null, 2)}</pre>{record.fact.type === 'request_prepared' && <button className="secondary-button" onClick={() => {
            const fact = record.fact
            if (fact.type === 'request_prepared') void api(`${base(session)}/request/${fact.request.id}`).then(setRequest).catch(error => report(String(error)))
          }}>重建模型请求</button>}</details>)}
          {request !== undefined && <section className="fact-record"><h3>模型请求</h3><p>统一输入可从会话重建。Provider 准备记录保留协议转换结果，认证信息省略。</p><pre data-testid="reconstructed-request">{JSON.stringify(request, null, 2)}</pre></section>}
        </>}
        {tab === 'panels' && <>
          {!enabled && <button className="secondary-button" onClick={onEnable}>加载已信任面板</button>}
          {views.filter(view => view.kind === 'panel').map(view => <section className="settings-card extension-card" key={`${view.plugin}:${view.name}`}><h3>{view.name}</h3><PluginView view={view} session={session} state={state} /></section>)}
          {enabled && !views.some(view => view.kind === 'panel') && <p className="muted-line">当前没有已启用的会话面板。</p>}
          <button className="secondary-button" onClick={onPlugins}>管理插件</button>
        </>}
        {tab === 'subagents' && <Subagents session={session} revision={state.seq} report={report} onSession={onSession} />}
      </div>
    </section>
  </aside>
}

function Subagents({ session, revision, report, onSession }: { session: string; revision: number; report(error: string): void; onSession(session: string): void }) {
  const [children, setChildren] = useState<{ name: string; state: Projection }[]>([])
  useEffect(() => {
    let stopped = false
    void (async () => {
      const names = await sessionNames()
      const children = await Promise.all(names.map(async name => ({ name, state: (await snapshot(name)).session })))
      if (!stopped) setChildren(children.filter(child => child.state.parent === session))
    })().catch(error => { if (!stopped) report(String(error)) })
    return () => { stopped = true }
  }, [session, revision, report])
  return <>{!children.length && <p className="muted-line">当前会话还没有子智能体。</p>}{children.map(child => <section className="settings-card extension-card" key={child.name}><h3>{child.name}</h3><p className="muted-line">{child.state.run ? '正在执行' : child.state.last_outcome ?? '就绪'}</p><button className="secondary-button" onClick={() => onSession(child.name)}>查看对话</button></section>)}</>
}

export function ApprovalDialog({ id, approval, busy, error, onDecide }: { id: string; approval: Approval; busy: boolean; error: string; onDecide(approved: boolean): void }) {
  const panel = useRef<HTMLElement>(null)
  useDialogFocus(panel, id)
  return <div className="approval-overlay" role="dialog" aria-modal="true" aria-labelledby="approval-title">
    <section className="approval-panel" ref={panel} tabIndex={-1}>
      <header><div><p className="eyebrow">操作确认</p><h2 id="approval-title">批准工具：{approval.name}</h2></div><IconButton title="拒绝" disabled={busy} onClick={() => onDecide(false)}><X size={20} /></IconButton></header>
      <p className="approval-reason"><Shield size={15} /> 这项操作需要你的确认。</p>
      <pre className="approval-body">{JSON.stringify(approval.input, null, 2)}</pre>
      {error && <p role="alert" className="execution-error">{error}</p>}
      <footer><button className="danger-button" disabled={busy} onClick={() => onDecide(false)}>拒绝</button><button className="approve-button" disabled={busy} onClick={() => onDecide(true)}><CheckCircle2 size={18} /><span>批准</span></button></footer>
    </section>
  </div>
}
