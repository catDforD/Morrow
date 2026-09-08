import { useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Info, Moon, PanelLeft, Puzzle, Settings2, Sun, X } from 'lucide-react'
import type { Projection } from '@morrow/sdk'
import { MiniIconButton } from './IconButton.js'
import { useDialogFocus } from './useDialogFocus.js'
import { PluginView, pageSection, type ClientView } from './plugins.js'

export type SettingsSection = 'general' | 'plugins' | 'about' | `page:${string}`
const sections = [
  { id: 'general', order: 10, label: '常规', icon: <Settings2 size={18} /> },
  { id: 'plugins', order: 90, label: '插件', icon: <Puzzle size={18} /> },
  { id: 'about', order: 100, label: '关于', icon: <Info size={18} /> },
] as const

export function Settings({ session, state, workspace, section, onSection, theme, onTheme, sidebarOpen, onSidebar, onBack, report, perform, enableClients, views }: {
  session: string; state: Projection; workspace: Projection; section: SettingsSection; onSection(value: SettingsSection): void
  theme: 'light' | 'dark'; onTheme(): void; sidebarOpen: boolean; onSidebar(open: boolean): void; onBack(): void
  report(error: string): void; perform(name: string, values?: object): Promise<boolean>; enableClients(): void; views: ClientView[]
}) {
  const sidebar = useRef<HTMLElement>(null)
  useDialogFocus(sidebar, sidebarOpen ? 'settings' : null)
  const pages = views.filter(view => view.kind === 'page')
  const selectedPage = pages.find(view => `page:${view.plugin}:${view.name}` === section)
  const tabs = [...sections, ...pages.map(view => ({ id: pageSection(view), label: view.name, icon: view.icon ?? <Puzzle size={18} />, order: view.order ?? 50 }))].sort((a, b) => a.order - b.order)
  const title = tabs.find(item => item.id === section)?.label ?? '插件页面'
  return <div className={`app-frame settings-frame${sidebarOpen ? ' sidebar-open' : ''}`}>
    <button className="mobile-sidebar-backdrop" type="button" aria-label="关闭设置导航" aria-hidden={!sidebarOpen} tabIndex={sidebarOpen ? 0 : -1} onClick={() => onSidebar(false)} />
    <aside id="settings-navigation" ref={sidebar} tabIndex={-1} className="app-sidebar settings-sidebar" aria-label="设置导航" inert={!sidebarOpen && window.matchMedia('(max-width: 900px)').matches}>
      <div className="sidebar-brand"><div className="brand-mark">M</div><div className="sidebar-brand-copy"><strong>Morrow</strong><span>设置</span></div><MiniIconButton title="关闭设置导航" onClick={() => onSidebar(false)}><X size={17} /></MiniIconButton></div>
      <button className="settings-back-button" type="button" onClick={onBack}><ArrowLeft size={18} /><span>返回工作区</span></button>
      <nav className="settings-navigation main-scroll" aria-label="设置分类">
        {tabs.map(item => <button className={`settings-nav-item${section === item.id ? ' active' : ''}`} type="button" key={item.id} aria-current={section === item.id ? 'page' : undefined} onClick={() => onSection(item.id)}>{item.icon}<span>{item.label}</span></button>)}
      </nav>
      <div className="settings-sidebar-footer"><span>当前会话</span><strong>{session}</strong></div>
    </aside>
    <main className="window-main settings-main">
      <header className="settings-mobile-header"><button className="mobile-menu-button" type="button" aria-label="打开设置导航" onClick={() => onSidebar(true)}><PanelLeft size={19} /></button><strong>{title}</strong><MiniIconButton title="返回工作区" onClick={onBack}><ArrowLeft size={17} /></MiniIconButton></header>
      <div className="settings-scroll main-scroll"><div className="settings-page">
        <header className="settings-page-header"><h1>{title}</h1></header>
        {section === 'general' && <section className="settings-card"><div className="settings-row"><span className="settings-row-icon">{theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />}</span><div className="settings-row-copy"><strong>外观</strong></div><button className="secondary-button" onClick={onTheme}>{theme === 'dark' ? '深色' : '浅色'} · 切换主题</button></div><InfoRow label="工作区">{state.workspace}</InfoRow><InfoRow label="操作权限">写入文件与 Shell 命令需要确认</InfoRow></section>}
        {section === 'plugins' && <PluginSettings state={state} workspace={workspace} perform={perform} enableClients={enableClients} report={report} />}
        {section === 'about' && <section className="settings-card"><InfoRow label="应用">Morrow</InfoRow><InfoRow label="会话">{session}</InfoRow><InfoRow label="核心">事实日志与 Cordis 插件</InfoRow></section>}
        {selectedPage && <PluginView key={`${selectedPage.plugin}:${selectedPage.name}`} view={selectedPage} session={session} state={state} />}
      </div></div>
    </main>
  </div>
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return <dl className="settings-info-row"><dt>{label}</dt><dd>{children}</dd></dl>
}

function PluginSettings({ state, workspace, perform, enableClients, report }: { state: Projection; workspace: Projection; perform(name: string, values?: object): Promise<boolean>; enableClients(): void; report(error: string): void }) {
  const [manifest, setManifest] = useState('')
  const [busy, setBusy] = useState(false)
  const versions = Object.values({ ...workspace.plugins, ...state.plugins })
  const trusted = new Set([...workspace.trusted, ...state.trusted])
  const bindings = { ...workspace.bindings, ...state.bindings }
  const change = async (action: string, hash: string) => {
    setBusy(true)
    try { if (await perform(action, { hash }) && action === 'activate') enableClients() }
    finally { setBusy(false) }
  }
  return <div className="extension-stack">
    <p className="muted-line">审阅并信任具体版本后即可启用。插件可提供工具、会话面板和设置页面。</p>
    {!versions.length && <p className="muted-line">当前会话还没有插件。</p>}
    {versions.map(version => <article className="plugin settings-card extension-card" key={version.hash}>
      <h2>{version.manifest.name}</h2><p>{version.manifest.description}</p><code className="extension-hash">{version.hash}</code>
      <details className="extension-source"><summary>审阅 Host / Client 源码与依赖锁</summary><h3>Host</h3><pre>{version.manifest.host}</pre><h3>Client</h3><pre>{version.manifest.client ?? '无客户端代码'}</pre><h3>依赖锁</h3><pre>{version.manifest.dependency_lock}</pre></details>
      <div className="extension-actions">{!trusted.has(version.hash) ? <button className="secondary-button" disabled={busy} onClick={() => void change('trust', version.hash)}>信任此版本</button> : <><span className="muted-line">已信任</span><button className="secondary-button" disabled={busy} onClick={() => void change('activate', version.hash)}>激活</button><button className="secondary-button" disabled={busy} onClick={() => void change('stop', version.hash)}>停用</button><button className="secondary-button" disabled={busy} onClick={() => void change('promote', version.hash)}>安装到工作区</button></>}<span className="muted-line">{bindings[version.manifest.name]?.active && bindings[version.manifest.name]?.hash === version.hash ? '已绑定' : '未启用'}</span></div>
    </article>)}
    <details className="settings-card extension-card"><summary>定义插件版本</summary><label className="extension-field">插件清单<textarea aria-label="Plugin manifest" value={manifest} onChange={event => setManifest(event.target.value)} rows={8} /></label><button className="secondary-button" onClick={() => { try { void perform('define', { manifest: JSON.parse(manifest) }) } catch (error) { report(String(error)) } }}>保存待审阅版本</button></details>
  </div>
}
