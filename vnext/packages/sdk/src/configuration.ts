import { Context, Service } from '@deepseek-ai/cordis'
import type { Provider, PublicProfile } from './provider.js'

export interface ManagedModel { id: string; name: string; contextWindow: number; vision: boolean }
export interface ProfileConfig extends PublicProfile { name: string; enabled: boolean; models: ManagedModel[]; preset?: string }
export interface ProfileInfo extends ProfileConfig { configured: boolean }
export interface ProfileUpdate {
  id: string; provider: string; options: Record<string, unknown>
  name?: string; enabled?: boolean; models?: ManagedModel[]; preset?: string
  baseUrl?: string; endpoint?: string; model?: string; apiKey?: string; makeDefault?: boolean
}
export interface ProfileStore {
  readonly defaultId: string
  public(id: string): ProfileConfig
  list(): Promise<ProfileInfo[]>
  save(input: ProfileUpdate): Promise<void>
  remove(id: string): Promise<void>
  assertPublic(value: unknown): void
  reveal(id: string): Promise<string>
  test(id: string, model: string, provider: Provider): Promise<{ latencyMs: number }>
}

declare module '@deepseek-ai/cordis' { interface Context { modelProfiles: ModelProfiles } }

/** Host-owned storage, shared by plugins through Cordis dependency injection. */
export class ModelProfiles extends Service {
  constructor(ctx: Context, private store: ProfileStore) { super(ctx, 'modelProfiles') }
  get defaultId() { return this.store.defaultId }
  get(id: string) { return this.store.public(id) }
  list() { return this.store.list() }
  save(input: ProfileUpdate) { return this.store.save(input) }
  remove(id: string) { return this.store.remove(id) }
  assertPublic(value: unknown) { this.store.assertPublic(value) }
  reveal(id: string) { return this.store.reveal(id) }
  test(id: string, model: string, provider: Provider) { return this.store.test(id, model, provider) }
}
