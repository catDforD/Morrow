import type { Context, Handler } from '@morrow/sdk'

export const name = 'morrow.settings'
export const version = '1'
type Selection = { profile: string; model: string }

export default {
  inject: ['modelProfiles'],
  apply(ctx: Context) {
    const profiles = ctx.modelProfiles
    const selection = (value: Selection) => {
      const profile = profiles.get(value?.profile)
      if (!profile.enabled) throw new Error('供应商已禁用，请选择其他模型')
      if (!profile.models.some(model => model.id === value.model)) throw new Error('模型已删除，请重新选择')
      return profile
    }
    const method = (name: string, handler: Handler) => ctx.morrow.method(name, async (input, run) => {
      try { return await handler(input, run) }
      catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
    })
    ctx.morrow.policy('20-settings', async (run, preparation, next) => {
      if (!preparation.header.profile && preparation.header.provider === run.defaults?.provider) {
        const selected = await run.state<Selection>('selection')
        if (!selected && !profiles.defaultId) throw new Error('请先在模型设置中添加并启用供应商和模型')
        const profile = selected ? selection(selected) : profiles.get(profiles.defaultId)
        preparation.header.profile = profile.id
        preparation.header.provider = profile.provider
        preparation.header.model = selected?.model ?? profile.model
      }
      await next()
    })
    method('profiles.get', async (_input, run) => ({ profiles: await profiles.list(), defaultId: profiles.defaultId, providers: ctx.morrow.registeredProviders(), formats: ctx.morrow.providerFormats(), selection: await run.state<Selection>('selection') ?? null }))
    method('profiles.save', async input => {
      if (!ctx.morrow.registeredProviders().includes(input?.provider)) throw new Error('此 Provider 尚未注册，请先启用对应插件')
      await profiles.save(input)
      return { saved: true }
    })
    method('profiles.remove', async input => { await profiles.remove(input?.id); return { removed: true } })
    method('profiles.reveal', async input => ({ apiKey: await profiles.reveal(input?.id) }))
    method('models.select', async (input: Selection | null, run) => {
      if (input === null) await run.deleteState('selection')
      else { selection(input); await run.setState('selection', { profile: input.profile, model: input.model }) }
      return { selected: true }
    })
    method('models.test', async input => {
      const profile = profiles.get(input?.id)
      const adapter = ctx.morrow.providerAdapter(profile.provider)
      if (!adapter) throw new Error('当前 API 格式尚未加载或不支持连接检测')
      return profiles.test(profile.id, input?.model, adapter)
    })
  },
}
