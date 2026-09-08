import { Context, Contributions, Morrow, ModelProfiles, RunContext } from '@morrow/sdk'
import type { Entry, Owner, PluginVersion, Projection, Rpc, Registration } from '@morrow/sdk'
import type { Fiber, Plugin } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { agent, builtin } from './defaults.js'
import { builtinPlugins } from './builtins/index.js'
import { ProviderService, Profiles } from './provider-service.js'
import { chatProvider, responsesProvider } from './providers.js'

interface Loaded { hash: string; fiber: Fiber }
interface SessionHost {
  ctx: Context; contributions: Contributions; loaded: Map<string, Loaded>
  generation: number; current?: RunContext; sync: Promise<void>
  scopes: string[]; driver?: Entry; pending: boolean
  contexts: Map<string, Context>
}

export class Host {
  readonly providers: ProviderService
  private sessions = new Map<string, SessionHost>()
  private initializing = new Map<string, Promise<SessionHost>>()
  private runs = new Map<string, AbortController>()
  constructor(readonly rpc: Rpc, readonly epoch: string, readonly home: string, readonly profiles: Profiles) { this.providers = new ProviderService(profiles) }
  async session(name: string): Promise<SessionHost> {
    const ready = this.sessions.get(name)
    if (ready) return ready
    const pending = this.initializing.get(name)
    if (pending) return pending
    const creating = this.createSession(name)
    this.initializing.set(name, creating)
    try {
      const session = await creating
      this.sessions.set(name, session)
      return session
    } finally { this.initializing.delete(name) }
  }
  private async createSession(name: string): Promise<SessionHost> {
    const ctx = new Context()
    const contributions = new Contributions()
    new Morrow(ctx, contributions)
    new ModelProfiles(ctx, this.profiles)
    const workspace = ctx.extend({ [Context.isolate]: Object.create(ctx[Context.isolate]) })
    const local = workspace.extend({ [Context.isolate]: Object.create(workspace[Context.isolate]) })
    const session: SessionHost = { ctx, contributions, loaded: new Map(), generation: 0, sync: Promise.resolve(), scopes: ['application', 'workspace', `session:${name}`], pending: false,
      contexts: new Map([['workspace', workspace], [`session:${name}`, local]]) }
    const owner = { plugin: 'morrow.builtin', version: '1', scope: 'application', epoch: this.epoch, generation: 0 }
    await ctx.extend({ morrowOwner: owner }).plugin(builtin)
    await ctx.extend({ morrowOwner: { ...owner, plugin: 'morrow.agent' } }).plugin(agent)
    for (const entry of builtinPlugins) await ctx.extend({ morrowOwner: { ...owner, plugin: entry.name, version: entry.version } }).plugin(entry.plugin)
    await ctx.extend({ morrowOwner: { ...owner, plugin: 'morrow.providers', version: 'provider-v2-1' } }).plugin(ctx => {
      ctx.morrow.provider('openai-chat', chatProvider)
      ctx.morrow.provider('openai-responses', responsesProvider)
      ctx.morrow.provider('openai', chatProvider)
    })
    return session
  }
  private async source(version: PluginVersion): Promise<Plugin> {
    const file = join(this.home, 'plugins', version.hash, 'host.mjs')
    if (await readFile(file, 'utf8') !== version.manifest.host) throw new Error(`plugin artifact changed: ${version.hash}`)
    // Hash is checked by Rust before binding; compare the complete persisted artifact too.
    const stored = JSON.parse(await readFile(join(this.home, 'plugins', version.hash, 'manifest.json'), 'utf8'))
    if (stored.hash !== version.hash || !isDeepStrictEqual(stored.manifest, version.manifest)) throw new Error('plugin manifest changed')
    const module = await import(pathToFileURL(file).href)
    if (!module.default) throw new Error('plugin must export default Cordis entrypoint')
    return module.default
  }
  async sync(name: string, state: Projection, workspace: Projection) {
    const session = await this.session(name)
    const work = session.sync.then(async () => {
      const desired = new Map<string, { version: PluginVersion; scope: string }>()
      for (const [scope, snapshot] of [['workspace', workspace], [`session:${name}`, state]] as const) {
        for (const [plugin, binding] of Object.entries(snapshot.bindings)) {
          if (!binding.active) continue
          if (!snapshot.trusted.includes(binding.hash)) throw new Error(`untrusted plugin ${binding.hash}`)
          const version = snapshot.plugins[binding.hash]
          if (!version) throw new Error(`missing plugin version ${binding.hash}`)
          desired.set(`${scope}/${plugin}`, { version, scope })
        }
      }
      const changed = [...session.loaded].some(([key, value]) => desired.get(key)?.version.hash !== value.hash)
        || [...desired].some(([key, value]) => session.loaded.get(key)?.hash !== value.version.hash)
      if (!changed) { session.pending = false; return }
      const pinned = session.driver?.registration
      let deferred = false
      for (const [key, loaded] of session.loaded) {
        if (pinned && key === `${pinned.scope}/${pinned.plugin}`) {
          if (desired.get(key)?.version.hash !== loaded.hash) deferred = true
          continue
        }
        await loaded.fiber.dispose()
        session.loaded.delete(key)
      }
      // Discover service declarations before loading consumers, so Cordis can park missing injections.
      const modules = new Map<string, Plugin>()
      for (const [key, { version }] of desired) if (!session.loaded.has(key)) modules.set(key, await this.source(version))
      // Explicit provides define DI isolation at each scope; inherited services keep ancestor labels.
      for (const [scope, context] of session.contexts) {
        const names = new Set<string>()
        for (const [key, plugin] of modules) {
          if (desired.get(key)!.scope !== scope) continue
          for (const name of typeof plugin.provide === 'string' ? [plugin.provide] : plugin.provide ?? []) names.add(name)
        }
        for (const name of Object.keys(context[Context.isolate])) if (!names.has(name)) delete context[Context.isolate][name]
        for (const name of names) context[Context.isolate][name] ??= Symbol(`${scope}:${name}`)
      }
      for (const [key, plugin] of modules) {
        const { version, scope } = desired.get(key)!
        const owner: Owner = { plugin: version.manifest.name, version: version.hash, scope, epoch: this.epoch, generation: ++session.generation }
        const fiber = await session.contexts.get(scope)!.extend({ morrowOwner: owner }).plugin(plugin)
        session.loaded.set(key, { hash: version.hash, fiber })
        if (fiber.state === 3) throw new Error(`plugin ${owner.plugin} failed`)
      }
      session.pending = deferred
    })
    session.sync = work.catch(() => {})
    return work
  }
  async changed(name: string) {
    if (name === '_workspace') { for (const name of this.sessions.keys()) await this.changed(name); return }
    const session = this.sessions.get(name)
    if (!session) return
    session.pending = true
    if (!session.current) {
      const state = await this.rpc.call<Projection>('session.get', { session: name, epoch: this.epoch })
      const workspace = await this.workspace(name)
      await this.sync(name, state, workspace)
    }
  }
  private workspace(name: string) { return this.rpc.call<Projection>('workspace.get', { session: name, epoch: this.epoch }) }
  async resume(name: string) {
    if ((await this.session(name)).current) return
    const state = await this.rpc.call<Projection>('session.get', { session: name, epoch: this.epoch })
    await this.sync(name, state, await this.workspace(name))
  }
  async run(params: { session: string; run: string; snapshot: Projection; workspace: Projection }) {
    const session = await this.session(params.session)
    if (session.current) throw new Error('session already running')
    const abort = new AbortController()
    this.runs.set(params.run, abort)
    const profile = this.profiles.defaultId ? this.profiles.public(this.profiles.defaultId) : { provider: 'openai-chat', model: '' }
    const run = new RunContext(this.rpc, params.session, params.run, this.epoch, abort.signal, profile.model, {
      begin: async () => {
        await this.sync(params.session, await run.snapshot(), await this.workspace(params.session))
        return session.contributions.snapshot(session.scopes)
      },
      end: async () => {},
    })
    run.defaults = { provider: profile.provider, model: profile.model, system: '', tools: [], parameters: {} }
    session.current = run
    try {
      await this.sync(params.session, params.snapshot, params.workspace)
      // Driver stays pinned through the entire run, even if its plugin is updated mid-run.
      session.driver = session.contributions.snapshot(session.scopes).find(e => e.registration.kind === 'driver' && e.registration.name === 'default')
      if (!session.driver) throw new Error('no default driver registered')
      const owned = run.forOwner(session.driver.registration, session.driver.signal)
      session.current = owned
      await session.driver.handler(null, owned)
    } finally {
      session.current = undefined
      session.driver = undefined
      this.runs.delete(params.run)
      this.providers.release(params.run)
      abort.abort()
      if (session.pending) await this.changed(params.session)
    }
  }
  cancel(run: string) { this.runs.get(run)?.abort() }
  cancelAll() { for (const abort of this.runs.values()) abort.abort() }
  async dispose() { this.cancelAll(); await Promise.all([...this.sessions.values()].map(s => s.ctx.fiber.dispose())) }
  async provider(phase: 'prepare' | 'execute', params: any) {
    const session = this.sessions.get(params.context.session)
    const run = session?.current
    if (!run || run.run !== params.context.run || run.step !== params.context.step) throw new Error('stale provider handle')
    const entry = run.entries.find(e => isDeepStrictEqual(e.registration, params.registration))
    if (!entry || entry.registration.kind !== 'model') throw new Error('stale provider registration')
    run.signal.throwIfAborted()
    return phase === 'prepare' ? this.providers.prepare(entry, run, params.request, params.input) : this.providers.execute(entry, run, params.request)
  }
  async invoke(registration: Registration, handle: { session: string; run: string; step: string }, input: unknown) {
    const session = this.sessions.get(handle.session)
    const run = session?.current
    if (!session || !run || run.run !== handle.run || run.step !== handle.step) throw new Error('stale run/step handle')
    const entry = run.entries.find(e => (['kind', 'name', 'plugin', 'version', 'scope', 'epoch', 'generation'] as const).every(key => e.registration[key] === registration[key]))
    if (!entry || registration.epoch !== this.epoch) throw new Error('stale registration generation')
    run.signal.throwIfAborted()
    return entry.handler(input, run.forOwner(registration, entry.signal))
  }
  async client(params: { session: string; plugin: string; hash: string; method: string; input: unknown }) {
    const session = await this.session(params.session)
    const entries = session.contributions.snapshot(session.scopes)
    const entry = entries.find(e => e.registration.kind === 'method' && e.registration.name === params.method && e.registration.plugin === params.plugin && e.registration.version === params.hash)
    if (!entry) throw new Error('public scoped method unavailable')
    const run = new RunContext(this.rpc, params.session, null, this.epoch, entry.signal, '', { begin: async () => [], end: async () => {} }, entry.registration)
    return entry.handler(params.input, run)
  }
}
