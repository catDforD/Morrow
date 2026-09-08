import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { ProviderError, legacyBody, text } from '@morrow/sdk'
import type { Entry, ModelInput, ModelResult, PreparedPlan, PreparedRequest, ProfileConfig, Provider, RunContext, ModelProgress, ProfileStore, ProfileUpdate } from '@morrow/sdk'
import { normalizeProfile } from './profile-config.js'

interface Profile extends ProfileConfig { credentialRef?: string }
interface Prepared { request: PreparedRequest; entry: Entry; profile: Profile; plan: PreparedPlan; promise?: Promise<ModelResult> }

export class Profiles implements ProfileStore {
  private secrets = new Set<string>()
  private local: Record<string, string> = {}
  private profiles = new Map<string, Profile>()
  private removed = new Set<string>()
  private writes: Promise<void> = Promise.resolve()
  defaultId = ''
  constructor(readonly home: string, readonly environment: NodeJS.ProcessEnv = process.env) {}
  async load(overrides: { model?: string; baseUrl?: string; profile?: string } = {}) {
    // CLI/environment configuration remains opt-in; a fresh Web installation has no suppliers.
    if (overrides.baseUrl || overrides.model || this.environment.OPENAI_BASE_URL || this.environment.OPENAI_MODEL || this.environment.OPENAI_API_KEY) {
      const baseUrl = overrides.baseUrl ?? this.environment.OPENAI_BASE_URL ?? 'https://api.deepseek.com/v1'
      const model = overrides.model ?? this.environment.OPENAI_MODEL ?? 'deepseek-chat'
      this.profiles.set('default', { ...normalizeProfile({ id: 'default', name: '命令行配置', provider: 'openai-chat', model, baseUrl, options: {} }), credentialRef: 'env:OPENAI_API_KEY' })
    }
    try {
      const config = JSON.parse(await readFile(join(this.home, 'providers.json'), 'utf8'))
      for (const [id, value] of Object.entries(config.profiles ?? {})) {
        const p = value as Profile
        this.profiles.set(id, { ...normalizeProfile({ ...p, id, options: p.options ?? {} }), credentialRef: p.credentialRef })
      }
      this.defaultId = config.defaultProfile ?? this.defaultId
      this.removed = new Set(config.removedProfiles ?? [])
      for (const id of this.removed) this.profiles.delete(id)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    try { this.local = JSON.parse(await readFile(join(this.home, 'credentials.json'), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (overrides.profile) this.get(overrides.profile)
    this.defaultId = this.chooseDefault(this.profiles, overrides.profile ?? this.defaultId)
    for (const profile of this.profiles.values()) {
      const url = new URL(profile.endpoint)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Provider endpoints must be credential-free HTTP URLs')
      const key = await this.resolve(profile.credentialRef, false)
      if (key) this.secrets.add(key)
    }
    for (const id of this.profiles.keys()) this.assertPublic(this.public(id))
  }
  get(id: string): Profile {
    const p = this.profiles.get(id)
    if (!p) throw new ProviderError('invalid_request', 'Unknown provider profile')
    return structuredClone(p)
  }
  public(id: string): ProfileConfig {
    const { credentialRef: _credential, ...profile } = this.get(id)
    return profile
  }
  async list() { return Promise.all([...this.profiles.keys()].map(async id => ({ ...this.public(id), configured: !!await this.resolve(this.get(id).credentialRef, false) }))) }
  save(input: ProfileUpdate): Promise<void> {
    return this.write(async () => {
      const profile: Profile = normalizeProfile(input, this.profiles.get(input?.id))
      this.assertPublic(profile)
      if (JSON.stringify(profile).length > 65_536) throw new Error('连接配置过大')
      profile.credentialRef = this.profiles.get(input.id)?.credentialRef
      const key = input.apiKey?.trim()
      if (key) {
        // A fresh reference leaves already prepared requests bound to their old credential.
        const ref = 'profile-' + crypto.randomUUID()
        profile.credentialRef = 'local:' + ref
        this.secrets.add(key)
        const { credentialRef: _reference, ...publicProfile } = profile
        this.assertPublic(publicProfile)
        await this.persist('credentials.json', { ...this.local, [ref]: key })
        this.local[ref] = key
      }
      const profiles = new Map(this.profiles).set(profile.id, profile)
      const removed = new Set(this.removed); removed.delete(profile.id)
      const defaultId = this.chooseDefault(profiles, input.makeDefault ? profile.id : this.defaultId)
      await this.persist('providers.json', { defaultProfile: defaultId, profiles: Object.fromEntries(profiles), removedProfiles: [...removed] })
      this.profiles = profiles; this.removed = removed; this.defaultId = defaultId
    })
  }
  remove(id: string): Promise<void> {
    return this.write(async () => {
      this.get(id)
      const profiles = new Map(this.profiles); profiles.delete(id)
      const removed = new Set(this.removed).add(id)
      const defaultId = this.chooseDefault(profiles, this.defaultId)
      await this.persist('providers.json', { defaultProfile: defaultId, profiles: Object.fromEntries(profiles), removedProfiles: [...removed] })
      this.profiles = profiles; this.removed = removed; this.defaultId = defaultId
    })
  }
  private chooseDefault(profiles: Map<string, Profile>, preferred: string) {
    const available = [...profiles.values()].filter(profile => profile.enabled && profile.model)
    return available.find(profile => profile.id === preferred)?.id ?? available[0]?.id ?? ''
  }
  async reveal(id: string) { return this.credential(this.get(id)) }
  async test(id: string, model: string, provider: Provider) {
    const profile = this.get(id)
    if (!profile.models.some(value => value.id === model)) throw new Error('模型不存在，请先保存配置')
    const started = performance.now()
    const plan = await provider.prepare({ header: { provider: profile.provider, model, system: '', tools: [], parameters: {} }, messages: [text('user', 'Reply with OK only.')], continuations: [null] }, this.public(id))
    this.assertPublic(plan)
    await provider.execute(plan, { signal: AbortSignal.timeout(30_000), credential: () => this.credential(profile), emit() {} })
    return { latencyMs: Math.round(performance.now() - started) }
  }
  private write(operation: () => Promise<void>) {
    const pending = this.writes.then(operation)
    this.writes = pending.catch(() => {})
    return pending
  }
  private async persist(name: string, value: unknown) {
    await mkdir(this.home, { recursive: true })
    const path = join(this.home, name), temporary = path + '.' + crypto.randomUUID() + '.tmp'
    try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, path) }
    finally { await rm(temporary, { force: true }) }
  }
  async credential(profile: Profile) {
    const key = await this.resolve(profile.credentialRef, true)
    this.secrets.add(key)
    return key
  }
  private async resolve(ref: string | undefined, required: boolean): Promise<string> {
    let value = ''
    if (ref?.startsWith('env:')) value = this.environment[ref.slice(4)] ?? ''
    else if (ref?.startsWith('local:')) value = this.local[ref.slice(6)] ?? ''
    else if (ref?.startsWith('file:')) {
      try { value = (await readFile(ref.slice(5), 'utf8')).trim() }
      catch { if (required) throw new ProviderError('authentication', 'Credential file unavailable') }
    } else if (ref) throw new ProviderError('authentication', 'Unsupported credential reference')
    if (required && !value) throw new ProviderError('authentication', 'Provider credential is not configured')
    return value
  }
  sanitize<T>(value: T): T {
    const source = JSON.stringify(value)
    if (source === undefined) return value
    let clean = source
    for (const secret of this.secrets) if (secret) clean = clean.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]')
    return JSON.parse(clean)
  }
  assertPublic(value: unknown) {
    if (!isDeepStrictEqual(value, this.sanitize(value))) throw new ProviderError('invalid_request', 'Prepared data contains a credential')
    const inspect = (item: unknown, depth = 0) => {
      if (depth > 64) throw new ProviderError('invalid_request', 'Provider data exceeds nesting limit')
      if (!item || typeof item !== 'object') return
      for (const [key, child] of Object.entries(item)) {
        if (/^(authorization|cookie|api[_-]?key|access_token|refresh_token)$/i.test(key)) throw new ProviderError('invalid_request', 'Credentials belong in the execution context')
        inspect(child, depth + 1)
      }
    }
    inspect(value)
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}

export class ProviderService {
  private prepared = new Map<string, Prepared>()
  constructor(readonly profiles: Profiles) {}
  release(run: string) { for (const [id, p] of this.prepared) if (p.request.run === run) this.prepared.delete(id) }
  async prepare(entry: Entry, run: RunContext, request: PreparedRequest, input: ModelInput) {
    if (this.prepared.has(request.id)) throw new ProviderError('invalid_request', 'Duplicate provider preparation')
    const custom: Profile = { id: 'custom', name: 'custom', enabled: true, models: [], provider: entry.registration.name, model: request.header.model, endpoint: '', options: {} }
    let profile = request.header.profile || this.profiles.defaultId ? this.profiles.get(request.header.profile ?? this.profiles.defaultId) : custom
    if (!profile.enabled) throw new ProviderError('invalid_request', '供应商已禁用，请重新选择模型')
    if (profile.provider !== entry.registration.name && !(profile.provider === 'openai-chat' && entry.registration.name === 'openai')) {
      if (request.header.profile) throw new ProviderError('invalid_request', 'Profile does not match provider')
      profile = custom
    }
    const { credentialRef: _credential, ...publicProfile } = profile
    if (entry.provider && input.header.tools.length && !entry.provider.capabilities.tools) throw new ProviderError('unsupported_capability', 'Provider does not support tools')
    const compiled = entry.provider
      ? await entry.provider.prepare(freeze(structuredClone(input)), freeze(publicProfile))
      : { format: 'legacy.callback.v1', payload: { body: legacyBody(input) } }
    const plan: PreparedPlan = { ...compiled, profile: structuredClone(publicProfile) as any }
    run.signal.throwIfAborted()
    this.profiles.assertPublic(plan)
    if (JSON.stringify(plan).length > 8_000_000) throw new ProviderError('invalid_request', 'Prepared plan too large')
    this.prepared.set(request.id, { request: structuredClone(request), entry, profile, plan: freeze(structuredClone(plan)) })
    return plan
  }
  execute(entry: Entry, run: RunContext, request: PreparedRequest): Promise<ModelResult> {
    const pending = this.prepared.get(request.id)
    const original = { ...request, plan: null }
    if (!pending || pending.entry !== entry || !isDeepStrictEqual(original, pending.request) || !isDeepStrictEqual(pending.plan, request.plan)) throw new ProviderError('invalid_request', 'Stale or changed provider execution')
    run.signal.throwIfAborted()
    // Register the Promise before yielding; duplicate RPC dispatch cannot send twice.
    return pending.promise ??= this.perform(pending, run)
  }
  private async perform(pending: Prepared, run: RunContext): Promise<ModelResult> {
    const { entry, request, plan, profile } = pending
    const signal = AbortSignal.any([run.signal, entry.signal])
    let events: ModelProgress[] = [], bytes = 0, sequence = 0, sending = false
    const flush = () => {
      if (!events.length || signal.aborted || sending) return
      const batch = events; events = []; bytes = 0
      sending = true
      void run.rpc.call('model.progress', { ...run.handle, request: request.id, sequence: ++sequence, events: batch }, signal).catch(() => {}).finally(() => { sending = false })
    }
    const timer = setInterval(flush, 40)
    const emit = (event: ModelProgress) => {
      if (signal.aborted) return
      const size = Buffer.byteLength(JSON.stringify(event))
      if (size > 16_384 || bytes + size > 24_000) { events = [{ type: 'gap' }]; bytes = 16; return }
      events.push(this.profiles.sanitize(event)); bytes += size
    }
    try {
      const output: ModelResult = entry.provider
        ? await entry.provider.execute(plan, { signal, credential: () => this.profiles.credential(profile), emit })
        : { message: await entry.handler({ ...request, body: (plan.payload as any).body }, run.forOwner(entry.registration, entry.signal)) as any, continuation: null, usage: null, finish_reason: 'stop' }
      const result = structuredClone(output)
      signal.throwIfAborted()
      if (result.continuation) result.continuation.provider = entry.registration.name
      flush()
      return this.profiles.sanitize(result)
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw new ProviderError(signal.aborted ? 'transport' : 'invalid_response', signal.aborted ? 'Provider cancelled' : 'Provider returned an invalid response', signal.aborted ? { outcome: 'unknown' } : {})
    } finally { clearInterval(timer) }
  }
}
