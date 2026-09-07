import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Bot, ChevronDown, ChevronRight, Eye, FileText, Folder, GitBranch, PencilLine, Shield, Square, Terminal } from 'lucide-react'
import type { Message, Projection, Record as FactRecord, ToolCall } from '@morrow/sdk'
import MarkdownContent from './MarkdownContent.js'
import { PluginView, type ClientView } from './plugins.js'

const homeHints = [
  { icon: <Eye size={14} />, label: '介绍这个项目', prompt: '介绍一下这个项目：主要结构、核心模块和它们之间的关系。' },
  { icon: <FileText size={14} />, label: '解释一段代码', prompt: '帮我解释这段代码的作用：' },
  { icon: <PencilLine size={14} />, label: '修一个 bug', prompt: '帮我定位并修复一个 bug：' },
  { icon: <Terminal size={14} />, label: '跑一下测试', prompt: '运行项目的测试，并总结失败原因。' },
]
const workspaceName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || '当前工作区'

export function HomePrompt({ workspace, onPickHint, children }: { workspace: string; onPickHint(value: string): void; children: ReactNode }) {
  return <div className="home-prompt">
    <div className="home-copy">
      <div className="home-mark" aria-hidden="true"><GitBranch size={32} strokeWidth={1.5} /></div>
      <h1>今天想一起完成什么？</h1>
      <span className="home-workspace" title={workspace}><Folder size={14} />{workspaceName(workspace)}</span>
    </div>
    {children}
    <div className="home-hints" aria-label="快速开始">{homeHints.map(hint => <button key={hint.label} type="button" className="home-hint" onClick={() => {
      onPickHint(hint.prompt)
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus())
    }}>{hint.icon}{hint.label}</button>)}</div>
  </div>
}

export function Composer({ prompt, onPromptChange, onSubmit, onCancel, running, busy, enabled, workspace, model, home, onManageModels }: {
  prompt: string; onPromptChange(value: string): void; onSubmit(): void; onCancel(): void
  running: boolean; busy: boolean; enabled: boolean; workspace: string; model: string; home: boolean; onManageModels(): void
}) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    if (!textarea.current) return
    textarea.current.style.height = 'auto'
    textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 220)}px`
  }, [prompt])
  return <form className={`composer ${home ? 'home' : 'dock'}`} onSubmit={event => { event.preventDefault(); onSubmit() }}>
    <div className="composer-shell"><div className="composer-card">
      <textarea ref={textarea} aria-label="消息" value={prompt} rows={home ? 3 : 2} disabled={!enabled || running || busy}
        placeholder="描述你想完成的工作" title="Enter 发送 · Shift / Ctrl + Enter 换行" onChange={event => onPromptChange(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); onSubmit() }
        }} />
      <div className="composer-bar"><div className="composer-left">
        <span className="permission-trigger permission-indicator" title="读取文件直接执行，写入文件和 Shell 命令需要确认"><Shield size={15} /><span className="permission-trigger-label">操作需确认</span></span>
      </div><div className="composer-primary">
        <button className="composer-chip labeled model-trigger" type="button" title="配置模型" onClick={onManageModels}><Bot size={15} /><span>{model || '配置模型'}</span><ChevronDown size={14} /></button>
        <button aria-label={running ? '停止执行' : '发送'} className={`send-button composer-primary-button${running ? ' stop-button' : ''}`}
          type={running ? 'button' : 'submit'} disabled={busy || !enabled || (!running && !prompt.trim())} onClick={running ? onCancel : undefined}>
          {running ? <Square size={17} /> : <ArrowUp size={18} />}
        </button>
      </div></div>
    </div><div className="composer-context" aria-label="工作区"><span title={workspace}><Folder size={13} />{workspaceName(workspace)}</span></div></div>
  </form>
}

type Entry = { id: number; message?: Message; notice?: string; tools: { call: ToolCall; result?: Message }[] }
function conversationFromFacts(records: FactRecord[]) {
  const entries: Entry[] = []
  const requests = new Map<string, string>()
  const calls = new Map<string, Entry['tools'][number]>()
  for (const { seq, fact } of records) {
    if (fact.type === 'request_prepared') requests.set(fact.request.id, fact.request.purpose)
    let message: Message | undefined
    if (fact.type === 'input_queued' || fact.type === 'context_appended') message = fact.message
    if (fact.type === 'model_settled' && requests.get(fact.request) === 'main') message = fact.message ?? undefined
    if (message) {
      const tools = message.tool_calls.map(call => { const tool = { call }; calls.set(call.id, tool); return tool })
      entries.push({ id: seq, message, tools })
    }
    if (fact.type === 'tool_settled') {
      const tool = calls.get(fact.call)
      if (tool) tool.result = fact.message
    }
    if (fact.type === 'surface_replaced') entries.push({ id: seq, notice: '已整理上下文，完整对话保留在此处。', tools: [] })
    if (fact.type === 'run_ended' && fact.outcome !== 'completed') entries.push({ id: seq, notice: `${fact.outcome === 'cancelled' ? '已停止执行' : '执行未完成'}${fact.reason ? `：${fact.reason}` : ''}`, tools: [] })
  }
  return entries
}

export function Conversation({ session, state, records, delta, views }: { session: string; state: Projection; records: FactRecord[]; delta: string; views: ClientView[] }) {
  const entries = useMemo(() => conversationFromFacts(records), [records])
  const toolRenderer = views.find(view => view.kind === 'renderer' && view.name === 'tool')
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const [showScroll, setShowScroll] = useState(false)
  const toBottom = () => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; stickToBottom.current = true; setShowScroll(false) }
  useLayoutEffect(() => { if (stickToBottom.current) toBottom() }, [entries, delta])
  return <div className="conversation-body"><div ref={scroller} className="message-scroll main-scroll" onScroll={event => {
    const node = event.currentTarget
    stickToBottom.current = node.scrollHeight - node.clientHeight - node.scrollTop < 80
    setShowScroll(!stickToBottom.current)
  }}><div className="message-column">
    {entries.map(entry => {
      if (!entry.message) return <p className="muted-line conversation-notice" key={entry.id}>{entry.notice}</p>
      const message = entry.message
      const renderer = views.find(view => view.kind === 'renderer' && view.name === message.role)
      return <div key={entry.id}>
        {message.reasoning || entry.tools.length ? <details className="execution-trace execution-action">
          <summary><ChevronRight size={14} className="execution-action-chevron" /><span>{entry.tools.length ? `执行了 ${entry.tools.length} 项操作` : '思考过程'}</span></summary>
          <div className="execution-stream">
            {message.reasoning && <MarkdownContent content={message.reasoning} className="execution-thought" />}
            {entry.tools.map(({ call, result }) => <details key={call.id} className="execution-action">
              <summary><Terminal size={14} /><span className="execution-action-label">{call.name}</span><span className="execution-action-status">{result === undefined ? '等待结果' : '已返回'}</span></summary>
              <div className="execution-action-details"><div className="execution-detail"><strong>输入</strong><pre>{JSON.stringify(call.arguments, null, 2)}</pre></div>
                {result !== undefined && <div className="execution-detail"><strong>结果</strong>{toolRenderer ? <PluginView view={toolRenderer} session={session} state={state} message={result} /> : <pre>{result.content}</pre>}</div>}
              </div>
            </details>)}
          </div>
        </details> : null}
        {renderer || message.content ? <article className={`message-row ${message.role}`}>
          <div className={`message-role ${message.role}`}>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'Morrow' : message.role}</div>
          {renderer ? <PluginView view={renderer} session={session} state={state} message={message} /> : message.role === 'assistant' ? <MarkdownContent content={message.content} className="message-bubble" /> : <pre className="message-bubble">{message.content}</pre>}
        </article> : null}
      </div>
    })}
    {delta && <article className="message-row assistant"><div className="message-role assistant">Morrow · 生成中</div><MarkdownContent content={delta} className="message-bubble" /></article>}
    {state.run && !delta && <p className="muted-line" role="status">正在执行…</p>}
  </div></div>{showScroll && <button className="scroll-to-bottom" type="button" aria-label="回到底部" onClick={toBottom}><ArrowDown size={17} /></button>}</div>
}
