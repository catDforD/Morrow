import { Context, Service } from '@deepseek-ai/cordis'
import type { Message, PluginManifest, PreparedRequest, Projection, Registration, RequestHeader, ToolDefinition } from './protocol.js'
import type { Provider } from './provider.js'
export * from './provider.js'
export * from './configuration.js'

export * from './protocol.js'
export { McpClient, mcp, type McpConfig } from './mcp.js'
export { Context, Service } from '@deepseek-ai/cordis'

export interface Rpc { call<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> }
export type Handler = (input: any, run: RunContext) => unknown | Promise<unknown>
export interface Owner { plugin: string; version: string; scope: string; epoch: string; generation: number }
export interface Entry { registration: Registration; handler: Handler; signal: AbortSignal; provider?: Provider }
export interface Driver { run(run: RunContext): Promise<void> }
export interface Preparation { header: RequestHeader; temporary: Message[] }
export type Policy = (run: RunContext, preparation: Preparation, next: () => Promise<void>) => Promise<void>

declare module '@deepseek-ai/cordis' {
  interface Context { morrow: Morrow; morrowOwner: Owner }
}

/** Scope precedence is separate from Cordis DI; a snapshot holds actual callbacks until step end. */
export class Contributions {
  private layers = new Map<string, Map<string, Entry>>()
  add(ctx: Context, kind: string, name: string, handler: Handler, tool: ToolDefinition | null = null, provider?: Provider) {
    const owner = ctx.morrowOwner
    if (!owner) throw new Error('registration needs plugin ownership')
    const entries = this.layers.get(owner.scope) ?? new Map<string, Entry>()
    this.layers.set(owner.scope, entries)
    const key = `${kind}:${name}`
    if (entries.has(key)) throw new Error(`duplicate ${key} in ${owner.scope}`)
    const lifetime = new AbortController()
    const entry = { registration: { ...owner, kind, name, tool }, handler, signal: lifetime.signal, provider }
    return ctx.effect(() => {
      entries.set(key, entry)
      return () => { lifetime.abort(); if (entries.get(key) === entry) entries.delete(key) }
    }, `morrow:${key}`)
  }
  snapshot(scopes: string[]): Entry[] {
    const visible = new Map<string, Entry>()
    for (const scope of scopes) for (const [key, entry] of this.layers.get(scope) ?? []) visible.set(key, entry)
    return [...visible.values()].sort((a, b) => `${a.registration.kind}:${a.registration.name}`.localeCompare(`${b.registration.kind}:${b.registration.name}`))
  }
}

/** Cordis tracks the caller ctx through Service; contributions belong to the calling plugin fiber. */
export class Morrow extends Service {
  constructor(ctx: Context, private contributions: Contributions) { super(ctx, 'morrow') }
  tool(definition: ToolDefinition, execute: Handler) { return this.contributions.add(this.ctx, 'tool', definition.name, execute, definition) }
  model(name: string, execute: (request: PreparedRequest & { body: unknown }, run: RunContext) => Promise<Message>) { return this.contributions.add(this.ctx, 'model', name, execute) }
  provider(name: string, provider: Provider) { return this.contributions.add(this.ctx, 'model', name, () => { throw new Error('provider requires execution context') }, null, provider) }
  driver(name: string, driver: Driver) { return this.contributions.add(this.ctx, 'driver', name, (_, run) => driver.run(run)) }
  policy(name: string, policy: Policy) { return this.contributions.add(this.ctx, 'policy', name, policy as unknown as Handler) }
  method(name: string, handler: Handler) { return this.contributions.add(this.ctx, 'method', name, handler) }
  registeredProviders() {
    return this.contributions.snapshot(['application', 'workspace', this.ctx.morrowOwner.scope])
      .filter(entry => entry.registration.kind === 'model').map(entry => entry.registration.name)
  }
  providerFormats() {
    return this.contributions.snapshot(['application', 'workspace', this.ctx.morrowOwner.scope])
      .filter(entry => entry.registration.kind === 'model')
      .map(entry => ({ id: entry.registration.name, label: entry.provider?.configuration?.label ?? entry.registration.name, requestPath: entry.provider?.configuration?.requestPath ?? '' }))
  }
  providerAdapter(name: string) {
    return this.contributions.snapshot(['application', 'workspace', this.ctx.morrowOwner.scope])
      .find(entry => entry.registration.kind === 'model' && entry.registration.name === name)?.provider
  }
}

export interface RunHooks {
  begin(run: RunContext): Promise<Entry[]>
  end(run: RunContext): Promise<void>
}

export class RunContext {
  defaults?: RequestHeader
  step: string | null = null
  lastRequest: string | null = null
  entries: Entry[] = []
  constructor(
    readonly rpc: Rpc, readonly session: string, readonly run: string | null,
    readonly epoch: string, readonly signal: AbortSignal, readonly modelName: string,
    private hooks: RunHooks, readonly owner?: Owner,
  ) {}

  get handle() { return { session: this.session, run: this.run, epoch: this.epoch, step: this.step, owner: this.owner } }
  get tools() { return this.entries.flatMap(e => e.registration.tool ? [e.registration.tool] : []) }
  private active() { this.signal.throwIfAborted(); if (!this.run) throw new Error('operation requires an active run') }
  async snapshot() { return this.rpc.call<Projection>('session.get', this.handle, this.signal) }
  async beginStep() {
    this.active()
    if (this.step) throw new Error('step already active')
    this.entries = await this.hooks.begin(this)
    this.step = crypto.randomUUID()
    await this.rpc.call('step.begin', { ...this.handle, registrations: this.entries.map(e => e.registration) }, this.signal)
  }
  async endStep() {
    this.active()
    await this.rpc.call('step.end', this.handle, this.signal)
    await this.hooks.end(this)
    this.step = null
    this.entries = []
  }
  async model(header: RequestHeader, options: { purpose?: string; surface?: string[]; temporary?: Message[]; retry_of?: string } = {}) {
    this.active()
    const id = crypto.randomUUID()
    this.lastRequest = id
    const result = await this.rpc.call<Message>('model.call', { ...this.handle, id, purpose: 'main', header, ...options }, this.signal)
    this.lastRequest = id
    return result
  }
  async tool(name: string, args: unknown, call?: string) {
    this.active()
    return this.rpc.call('tools.call', { ...this.handle, id: call ? `tool:${this.step}:${call}` : crypto.randomUUID(), name, arguments: args, call }, this.signal)
  }
  async settle(call: string, output: unknown) {
    this.active()
    return this.rpc.call('tools.settle', { ...this.handle, call, output }, this.signal)
  }
  async append(message: Message) { this.active(); return this.rpc.call('context.append', { ...this.handle, message }, this.signal) }
  async replace(revision: number, start: string, end: string, message: Message, sourceRequest?: string) {
    this.active()
    return this.rpc.call<{ revision: number }>('context.replace', { ...this.handle, revision, start, end, message, source_request: sourceRequest }, this.signal)
  }
  async define(manifest: PluginManifest) { return this.rpc.call<{ hash: string; trusted: boolean }>('plugin.define', { ...this.handle, manifest }, this.signal) }
  async activate(hash: string) { return this.rpc.call('plugin.activate', { ...this.handle, hash }, this.signal) }
  async stop(hash: string) { return this.rpc.call('plugin.stop', { ...this.handle, hash }, this.signal) }
  async state<T = unknown>(key: string): Promise<T | undefined> {
    return (await this.snapshot()).plugin_state[this.namespace]?.[key] as T | undefined
  }
  async setState(key: string, value: unknown) { return this.rpc.call('state.set', { ...this.handle, namespace: this.namespace, key, value }, this.signal) }
  async deleteState(key: string) { return this.rpc.call('state.delete', { ...this.handle, namespace: this.namespace, key }, this.signal) }
  async emit(name: string, data: unknown, version = 1) { return this.rpc.call('fact.emit', { ...this.handle, namespace: this.namespace, name, data, version }, this.signal) }
  async subagent(prompt: string) { this.active(); return this.rpc.call('subagent.run', { ...this.handle, prompt }, this.signal) }
  get namespace() { if (!this.owner) throw new Error('plugin state requires an owner'); return this.owner.plugin }
  forOwner(owner: Owner, lifetime?: AbortSignal) {
    const signal = lifetime ? AbortSignal.any([this.signal, lifetime]) : this.signal
    const owned = new RunContext(this.rpc, this.session, this.run, this.epoch, signal, this.modelName, this.hooks, owner)
    owned.step = this.step
    owned.defaults = this.defaults
    owned.entries = this.entries
    return owned
  }
  async prepare(initial: Preparation) {
    const policies = this.entries.filter(e => e.registration.kind === 'policy')
    const dispatch = async (index: number): Promise<void> => {
      const entry = policies[index]
      if (!entry) return
      let called = false
      await (entry.handler as unknown as Policy)(this.forOwner(entry.registration, entry.signal), initial, async () => {
        if (called) throw new Error('policy next() called twice')
        called = true
        await dispatch(index + 1)
      })
    }
    await dispatch(0)
    return initial
  }
}

export function text(role: Message['role'], content: string): Message {
  return { role, content, reasoning: '', tool_calls: [], tool_call_id: null }
}
