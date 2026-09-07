import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Bot, PanelLeft, Puzzle, Shield, X } from 'lucide-react'
import AppSidebar from './AppSidebar.js'
import AppErrorBoundary from './AppErrorBoundary.js'
import { MiniIconButton } from './IconButton.js'
import { Composer, Conversation, HomePrompt } from './Conversation.js'
import { ApprovalDialog, Inspector, type InspectorTab } from './Inspector.js'
import { Settings, type SettingsSection } from './Settings.js'
import { useSession } from './useSession.js'
import { snapshot } from './api.js'
import './styles.css'
import './style.css'

function useMedia(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const media = matchMedia(query)
    const change = () => setMatches(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [query])
  return matches
}

function App() {
  const [session, setSession] = useState(() => sessionStorage.getItem('morrow-session') || 'default')
  return <Workspace key={session} session={session} onSession={name => { sessionStorage.setItem('morrow-session', name); setSession(name) }} />
}

function Workspace({ session, onSession }: { session: string; onSession(name: string): void }) {
  const { data, timeline, sessions, error, setError, delta, connection, enabled, setEnabled, views, refresh, refreshDirectory, perform } = useSession(session)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const stored = localStorage.getItem('morrow-theme')
    return stored === 'dark' || (stored !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'
  })
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const mobile = useMedia('(max-width: 900px)')
  const overlayInspector = useMedia('(max-width: 1199px)')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const [archived, setArchived] = useState<string[]>([])
  const [settings, setSettings] = useState<SettingsSection | null>(null)
  const [inspector, setInspector] = useState<InspectorTab | null>(null)
  const state = data?.session
  const archiveKey = state && `morrow-archived:${state.workspace}`
  const pending = state?.run ? Object.entries(state.approvals).find(([, approval]) => approval.approved === null && approval.run === state.run!.id) : undefined
  const empty = !timeline.some(record => ['input_queued', 'context_appended', 'model_settled'].includes(record.fact.type))

  useEffect(() => { document.documentElement.classList.toggle('dark', theme === 'dark'); localStorage.setItem('morrow-theme', theme) }, [theme])
  useEffect(() => {
    if (!archiveKey) return
    try {
      const saved = JSON.parse(localStorage.getItem(archiveKey) || '[]')
      setArchived(Array.isArray(saved) ? saved.filter(value => typeof value === 'string') : [])
    } catch { setArchived([]) }
  }, [archiveKey])
  useEffect(() => { if (searchOpen) searchInput.current?.focus() }, [searchOpen])
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || pending) return
      if (inspector) setInspector(null)
      else { setSidebarOpen(false); setCreating(false) }
    }
    document.addEventListener('keydown', keyDown)
    return () => document.removeEventListener('keydown', keyDown)
  }, [inspector, pending])

  const toggleTheme = () => setTheme(current => current === 'dark' ? 'light' : 'dark')
  const openSettings = (section: SettingsSection) => { setSettings(section); setSidebarOpen(false) }
  const create = async () => {
    const trimmed = name.trim()
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(trimmed) || trimmed === '_workspace') { setCreateError('使用 1–128 位字母、数字、短横线或下划线。'); return }
    if (sessions.some(entry => entry.name === trimmed)) { setCreateError('这个会话名称已存在。'); return }
    try { await snapshot(trimmed); onSession(trimmed) } catch (error) { setCreateError(String(error)) }
  }
  const archive = (target: string, remove: boolean) => {
    const next = remove ? archived.filter(value => value !== target) : [...archived, target]
    setArchived(next)
    if (archiveKey) localStorage.setItem(archiveKey, JSON.stringify(next))
  }
  const submit = async () => {
    if (!prompt.trim() || busy || !state || state.run) return
    setBusy(true)
    try { if (await perform('submit', { text: prompt, submission: crypto.randomUUID() })) { setPrompt(''); setEnabled(true) } }
    finally { setBusy(false) }
  }
  const decide = async (approved: boolean) => {
    if (!pending || busy) return
    setBusy(true)
    try { await perform('approve', { id: pending[0], approved }) } finally { setBusy(false) }
  }
  const filtered = sessions.filter(entry => entry.name.toLowerCase().includes(filter.toLowerCase()))
  const config = state?.plugin_state['morrow.settings']?.model
  const configuredModel = config && typeof config === 'object' && !Array.isArray(config) && typeof config.model === 'string' ? config.model : ''
  const model = configuredModel || Object.values(state?.requests ?? {}).at(-1)?.header.model || ''
  const connectionState = pending ? 'approval' : state?.run ? 'running' : connection
  const connectionLabels = { connected: '已连接', connecting: '连接中', disconnected: '未连接', running: '正在执行', approval: '等待确认' }
  const composer = <Composer prompt={prompt} onPromptChange={setPrompt} onSubmit={() => void submit()} onCancel={() => void perform('cancel')}
    running={Boolean(state?.run)} busy={busy} enabled={Boolean(state)} workspace={state?.workspace ?? ''} model={model} home={empty} onManageModels={() => openSettings('models')} />

  return <>
    <div inert={Boolean(pending)}>
      {error && <div className="session-status-banner error app-status" role="alert"><span>{error}</span><button type="button" onClick={() => { setError(''); void refresh(); void refreshDirectory() }}>重试</button><MiniIconButton title="关闭提示" onClick={() => setError('')}><X size={14} /></MiniIconButton></div>}
      {settings && state && data ? <Settings session={session} state={state} workspace={data.workspace} section={settings} onSection={section => { setSettings(section); setSidebarOpen(false) }}
        theme={theme} onTheme={toggleTheme} sidebarOpen={sidebarOpen} onSidebar={setSidebarOpen} onBack={() => { setSettings(null); setSidebarOpen(false) }} report={setError}
        perform={perform} enableClients={() => setEnabled(true)} views={views} onSaved={refresh} /> :
        <div className={`app-frame${sidebarOpen ? ' sidebar-open' : ''}${collapsed ? ' sidebar-collapsed' : ''}${inspector ? ' inspector-open' : ''}`}>
          <button className="mobile-sidebar-backdrop" type="button" aria-label="关闭会话导航" aria-hidden={!sidebarOpen} tabIndex={sidebarOpen ? 0 : -1} onClick={() => setSidebarOpen(false)} />
          <AppSidebar sessions={filtered.filter(entry => !archived.includes(entry.name))} archivedSessions={filtered.filter(entry => archived.includes(entry.name))}
            sessionCount={sessions.filter(entry => !archived.includes(entry.name)).length} runningTurn={state?.run ?? null} selected={session} sessionAction={busy ? 'pending' : null}
            isCreatingSession={creating} newSessionName={name} createSessionError={createError} isSearchOpen={searchOpen} sessionFilter={filter} theme={theme} searchInputRef={searchInput}
            isHidden={(mobile ? !sidebarOpen : collapsed) || Boolean(inspector && overlayInspector)} onSelectSession={target => { setSidebarOpen(false); onSession(target) }}
            onStartCreateSession={() => { setCreating(true); setCreateError(null); setName(''); setSidebarOpen(true); setCollapsed(false) }} onCancelCreateSession={() => setCreating(false)}
            onNewSessionNameChange={setName} onCreateSession={() => void create()} onToggleSearch={() => { setSearchOpen(current => !current); setFilter('') }} onSessionFilterChange={setFilter}
            onArchiveSession={target => archive(target, false)} onRestoreSession={target => archive(target, true)} onRefresh={() => { void refresh(); void refreshDirectory() }}
            onClose={() => { setSidebarOpen(false); if (!mobile) setCollapsed(true) }} onOpenSettings={() => openSettings('general')} onThemeToggle={toggleTheme} />
          <main className="window-main" inert={(mobile && sidebarOpen) || Boolean(inspector && overlayInspector)}><section className={`conversation-panel${empty ? ' home-mode' : ''}`}>
            <header className="conversation-header"><div className="conversation-title">
              <button className="mobile-menu-button" type="button" aria-label="打开会话导航" aria-controls="task-navigation" aria-expanded={sidebarOpen || (!mobile && !collapsed)} onClick={() => { setSidebarOpen(true); setCollapsed(false) }}><PanelLeft size={19} /></button>
              <h1 title={session}>{session}</h1>
            </div><div className="conversation-actions">
              <span className={`connection-badge ${connectionState}`} title={connectionLabels[connectionState]} aria-label={connectionLabels[connectionState]}><span />{connectionLabels[connectionState]}</span>
              <MiniIconButton title="查看执行详情" onClick={() => setInspector('facts')}><Shield size={16} /></MiniIconButton>
              <MiniIconButton title="查看子智能体" onClick={() => setInspector('subagents')}><Bot size={16} /></MiniIconButton>
              <MiniIconButton title="查看会话面板" onClick={() => setInspector('panels')}><Puzzle size={16} /></MiniIconButton>
            </div></header>
            {empty ? <HomePrompt workspace={state?.workspace ?? ''} onPickHint={setPrompt}>{composer}</HomePrompt> : <>{state && <Conversation session={session} state={state} records={timeline} delta={delta} views={views} />}{composer}</>}
          </section></main>
          {inspector && state && <Inspector session={session} state={state} records={timeline} views={views} tab={inspector} onTab={setInspector} onClose={() => setInspector(null)} enabled={enabled}
            onEnable={() => setEnabled(true)} report={setError} onSession={onSession} onPlugins={() => openSettings('plugins')} />}
        </div>}
    </div>
    {pending && <ApprovalDialog id={pending[0]} approval={pending[1]} busy={busy} error={error} onDecide={approved => void decide(approved)} />}
  </>
}

createRoot(document.getElementById('root')!).render(<AppErrorBoundary><App /></AppErrorBoundary>)
