import * as React from 'react'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Projection, Message } from '@morrow/sdk'
import { action, base, token } from './api.js'
import { builtinClients } from './builtins/index.js'

export interface PanelProps {
  state: Record<string, unknown>
  invoke(method: string, input?: unknown): Promise<unknown>
  message?: Message
  disabled?: boolean
  openPage?(name: string): void
}
type View = React.ComponentType<PanelProps>
export interface PageOptions { order?: number; icon?: React.ReactNode; shortcut?: string }
export interface ClientView extends PageOptions { kind: string; name: string; plugin: string; hash: string; component: View }
export const pageSection = (view: ClientView): `page:${string}` => `page:${view.plugin}:${view.name}`
type ClientIdentity = { hash: string; manifest: { name: string } }
declare module '@deepseek-ai/cordis' { interface Context { ui: UI; clientVersion: ClientIdentity } }

class UI extends Service {
  readonly react = React
  constructor(ctx: Context, private views: Map<string, ClientView>, private changed: () => void) { super(ctx, 'ui') }
  panel(name: string, component: View) { return this.register('panel', name, component) }
  page(name: string, component: View, options: PageOptions = {}) { return this.register('page', name, component, options) }
  renderer(name: string, component: View) { return this.register('renderer', name, component) }
  composer(name: string, component: View, options: PageOptions = {}) { return this.register('composer', name, component, options) }
  private register(kind: string, name: string, component: View, options: PageOptions = {}) {
    const version = this.ctx.clientVersion
    const key = `${version.manifest.name}:${kind}:${name}`
    if (this.views.has(key)) throw new Error(`duplicate client registration ${key}`)
    return this.ctx.effect(() => {
      this.views.set(key, { ...options, kind, name, component, plugin: version.manifest.name, hash: version.hash })
      this.changed()
      return () => { this.views.delete(key); this.changed() }
    })
  }
}

export class Clients {
  private ctx = new Context()
  private loaded = new Map<string, { hash: string; fiber: Fiber }>()
  private builtins = new Map<string, Fiber>()
  private views = new Map<string, ClientView>()
  private disposed = false
  private work: Promise<void> = Promise.resolve()
  constructor(private session: string, changed: (views: ClientView[]) => void) {
    new UI(this.ctx, this.views, () => changed([...this.views.values()]))
  }
  sync(state: Projection, workspace: Projection, enabled = true) {
    const work = this.work.then(async () => {
      if (this.disposed) return
      for (const entry of builtinClients) {
        if (this.builtins.has(entry.name)) continue
        const fiber = await this.ctx.extend({ clientVersion: { hash: entry.version, manifest: { name: entry.name } } }).plugin(entry.plugin)
        this.builtins.set(entry.name, fiber)
        if (fiber.state === 3) throw new Error('built-in client plugin failed')
      }
      if (!enabled) return
      const bindings = { ...workspace.bindings, ...state.bindings }
      const versions = { ...workspace.plugins, ...state.plugins }
      const trusted = new Set([...workspace.trusted, ...state.trusted])
      for (const [name, loaded] of this.loaded) {
        const binding = bindings[name]
        if (binding?.active && binding.hash === loaded.hash) continue
        await loaded.fiber.dispose()
        this.loaded.delete(name)
      }
      for (const [name, binding] of Object.entries(bindings)) {
        const version = versions[binding.hash]
        if (!binding.active || !trusted.has(binding.hash) || !version?.manifest.client || this.loaded.has(name)) continue
        const response = await fetch(`${base(this.session)}/plugin/${binding.hash}`, { headers: { authorization: `Bearer ${token()}` } })
        if (!response.ok) throw new Error('client artifact unavailable')
        const source = await response.text()
        if (this.disposed) return
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
        try {
          const module = await import(/* @vite-ignore */ url)
          if (this.disposed) return
          const fiber = await this.ctx.extend({ clientVersion: version }).plugin(module.default)
          this.loaded.set(name, { hash: binding.hash, fiber })
          if (fiber.state === 3) throw new Error('client plugin failed')
        } finally { URL.revokeObjectURL(url) }
      }
    })
    this.work = work.catch(() => {})
    return work
  }
  async dispose() { this.disposed = true; await this.work; await this.ctx.fiber.dispose() }
}

export class PluginBoundary extends React.Component<React.PropsWithChildren<{ name: string }>, { error?: string }> {
  state: { error?: string } = {}
  static getDerivedStateFromError(error: Error) { return { error: error.message } }
  render() { return this.state.error ? <p role="alert">{this.props.name}: {this.state.error}</p> : this.props.children }
}

export function PluginView({ view, session, state, message, disabled, openPage }: { view: ClientView; session: string; state: Projection; message?: Message; disabled?: boolean; openPage?(name: string): void }) {
  const View = view.component
  const invoke = React.useCallback((method: string, input?: unknown) => action(session, 'invoke', { plugin: view.plugin, hash: view.hash, method, input }), [session, view.plugin, view.hash])
  return <PluginBoundary key={view.hash} name={view.plugin}><View message={message} state={state.plugin_state[view.plugin] ?? {}} invoke={invoke} disabled={disabled} openPage={openPage} /></PluginBoundary>
}
