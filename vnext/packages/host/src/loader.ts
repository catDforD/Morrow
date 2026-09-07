import { Context, Contributions, Morrow, RunContext } from '@morrow/sdk'
import type { Entry, Owner, PluginVersion, Projection, Rpc, Registration } from '@morrow/sdk'
import type { Fiber, Plugin } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { agent, builtin, settings } from './defaults.js'

interface Loaded { hash: string; fiber: Fiber }
interface SessionHost {
  ctx: Context; contributions: Contributions; loaded: Map<string, Loaded>
  generation: number; current?: RunContext; sync: Promise<void>
  scopes: string[]; driver?: Entry; pending: boolean
  contexts: Map<string, Context>
}

export class Host {
  private sessions = new Map<string, SessionHost>()
  private runs = new Map<string, AbortController>()
  constructor(readonly rpc: Rpc, readonly epoch: string, readonly home: string) {}
  async session(name: string): Promise<SessionHost> {
    let session = this.sessions.get(name)
    if (session) return session
    const ctx = new Context()
    const contributions = new Contributions()
    new Morrow(ctx, contributions)
    const workspace = ctx.extend({ [Context.isolate]: Object.create(ctx[Context.isolate]) })
    const local = workspace.extend({ [Context.isolate]: Object.create(workspace[Context.isolate]) })
    session = { ctx, contributions, loaded: new Map(), generation: 0, sync: Promise.resolve(), scopes: ['application', 'workspace', `session:${name}`], pending: false,
      contexts: new Map([['workspace', workspace], [`session:${name}`, local]]) }
    this.sessions.set(name, session)
    const owner = { plugin: 'morrow.builtin', version: '1', scope: 'application', epoch: this.epoch, generation: 0 }
    await ctx.extend({ morrowOwner: owner }).plugin(builtin)
    await ctx.extend({ morrowOwner: { ...owner, plugin: 'morrow.agent' } }).plugin(agent)
    await ctx.extend({ morrowOwner: { ...owner, plugin: 'morrow.settings' } }).plugin(settings)
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
  async run(params: { session: string; run: string; snapshot: Projection; workspace: Projection; model: string }) {
    const session = await this.session(params.session)
    if (session.current) throw new Error('session already running')
    const abort = new AbortController()
    this.runs.set(params.run, abort)
    const run = new RunContext(this.rpc, params.session, params.run, this.epoch, abort.signal, params.model, {
      begin: async () => {
        await this.sync(params.session, await run.snapshot(), await this.workspace(params.session))
        return session.contributions.snapshot(session.scopes)
      },
      end: async () => {},
    })
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
      abort.abort()
      if (session.pending) await this.changed(params.session)
    }
  }
  cancel(run: string) { this.runs.get(run)?.abort() }
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
    const session = this.sessions.get(params.session)
    if (!session) throw new Error('resume execution to start this plugin host')
    const entries = session.contributions.snapshot(session.scopes)
    const entry = entries.find(e => e.registration.kind === 'method' && e.registration.name === params.method && e.registration.plugin === params.plugin && e.registration.version === params.hash)
    if (!entry) throw new Error('public scoped method unavailable')
    const run = new RunContext(this.rpc, params.session, null, this.epoch, entry.signal, '', { begin: async () => [], end: async () => {} }, entry.registration)
    return entry.handler(params.input, run)
  }
}
