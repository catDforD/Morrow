import type { ManagedModel, ProfileConfig, ProfileUpdate } from '@morrow/sdk'

const model = (value: ManagedModel): ManagedModel => {
  if (!value || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 256) throw new Error('请填写有效的模型 ID')
  if (typeof value.name !== 'string' || value.name.length > 256) throw new Error('模型名称过长')
  if (!Number.isSafeInteger(value.contextWindow) || value.contextWindow < 0 || value.contextWindow > 100_000_000) throw new Error('上下文窗口必须是有效的非负整数')
  if (typeof value.vision !== 'boolean') throw new Error('视觉能力格式不正确')
  return { id: value.id.trim(), name: value.name.trim() || value.id.trim(), contextWindow: value.contextWindow, vision: value.vision }
}

export function normalizeProfile(input: ProfileUpdate, previous?: ProfileConfig): ProfileConfig {
  if (!input || typeof input !== 'object' || typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.id)) throw new Error('供应商 ID 只能包含字母、数字、短横线或下划线')
  if (typeof input.provider !== 'string' || !input.provider.trim()) throw new Error('请选择 API 格式')
  if (!input.options || typeof input.options !== 'object' || Array.isArray(input.options)) throw new Error('请求参数必须是 JSON 对象')
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 128)) throw new Error('请填写 1–128 位供应商名称')
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('启用状态格式不正确')
  if (input.model !== undefined && typeof input.model !== 'string') throw new Error('模型 ID 格式不正确')
  if (input.preset !== undefined && (typeof input.preset !== 'string' || input.preset.length > 64)) throw new Error('供应商模板格式不正确')
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 65_536)) throw new Error('API key 格式不正确')
  if (input.makeDefault !== undefined && typeof input.makeDefault !== 'boolean') throw new Error('默认连接选项格式不正确')
  let baseUrl = input.baseUrl ?? (input.endpoint === undefined ? previous?.baseUrl : undefined)
  const endpoint = baseUrl ?? input.endpoint ?? previous?.endpoint
  if (typeof endpoint !== 'string' || !endpoint.trim()) throw new Error('请填写 Base URL')
  const url = new URL(endpoint.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL 必须是不含认证信息的 HTTP URL')
  // Older settings saved service prefixes in endpoint. Recover their Base URL semantics on load.
  if (baseUrl === undefined && /^\/(?:.*\/)?v\d+\/?$/.test(url.pathname)) baseUrl = endpoint.trim()
  let models = input.models ?? previous?.models ?? []
  if (!Array.isArray(models) || models.length > 1000) throw new Error('模型列表格式不正确或数量过多')
  if (input.models === undefined && input.model?.trim() && !models.some(value => value.id === input.model!.trim())) {
    models = [...models, { id: input.model.trim(), name: input.model.trim(), contextWindow: 0, vision: false }]
  }
  models = models.map(model)
  if (new Set(models.map(value => value.id)).size !== models.length) throw new Error('模型 ID 不能重复')
  const selected = input.model ?? previous?.model
  const defaultModel = models.find(value => value.id === selected)?.id ?? models[0]?.id ?? ''
  const enabled = input.enabled ?? previous?.enabled ?? true
  if (input.makeDefault && (!enabled || !defaultModel)) throw new Error('默认供应商需要启用并至少添加一个模型')
  return {
    id: input.id, name: input.name?.trim() ?? previous?.name ?? input.id,
    provider: input.provider.trim(), enabled, models, model: defaultModel,
    endpoint: endpoint.trim(), ...(baseUrl !== undefined ? { baseUrl: baseUrl.trim().replace(/\/+$/, '') } : {}),
    options: structuredClone(input.options), ...((input.preset ?? previous?.preset) ? { preset: input.preset ?? previous?.preset } : {}),
  }
}
