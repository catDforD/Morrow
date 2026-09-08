import { ProviderError, legacyBody, text } from '@morrow/sdk'
import type { Provider, ModelInput, ModelResult, PreparedPlan, ProviderExecutionContext, PublicProfile } from '@morrow/sdk'

const common = ['temperature', 'top_p', 'seed']
const chatOptions = [...common, 'max_tokens', 'max_completion_tokens', 'reasoning_effort', 'thinking', 'response_format', 'parallel_tool_calls', 'tool_choice']
const responseOptions = [...common, 'max_output_tokens', 'reasoning', 'text', 'parallel_tool_calls', 'tool_choice', 'store']

function prepare(input: ModelInput, profile: PublicProfile, responses: boolean): PreparedPlan {
  // Opaque reasoning belongs to its adapter. Switching protocols must not silently lose it.
  for (const continuation of input.continuations) {
    if (continuation && (!responses || continuation.provider !== input.header.provider || continuation.format !== 'openai.responses.items.v1')) {
      throw new ProviderError('unsupported_capability', 'Context contains incompatible provider continuation; use a new session or compact with the original provider first')
    }
  }
  const options = { ...profile.options, ...(input.header.parameters as object) } as Record<string, any>
  const allowed = responses ? responseOptions : chatOptions
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new ProviderError('invalid_request', 'Unsupported model parameter: ' + key)
  if (responses && options.store === true) throw new ProviderError('unsupported_capability', 'Remote conversation storage is not enabled')
  const body: any = responses ? {
    ...options, model: input.header.model, instructions: input.header.system, input: responseInput(input),
    tools: input.header.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })),
    stream: true, store: false, include: ['reasoning.encrypted_content'],
  } : { ...legacyBody(input), ...options }
  const endpoint = profile.baseUrl === undefined ? profile.endpoint : profile.baseUrl.replace(/\/+$/, '') + (responses ? '/responses' : '/chat/completions')
  return { format: responses ? 'openai.responses.http.v1' : 'openai.chat.http.v1', payload: { endpoint, body } }
}

function responseInput(input: ModelInput): any[] {
  return input.messages.flatMap((message, index): any[] => {
    const continuation = input.continuations[index]
    if (continuation?.provider === input.header.provider && continuation.format === 'openai.responses.items.v1') {
      if (!Array.isArray(continuation.data)) throw new ProviderError('invalid_request', 'Invalid continuation data')
      return continuation.data
    }
    if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.tool_call_id, output: message.content }]
    const items: any[] = message.content ? [{ role: message.role, content: message.content }] : []
    for (const call of message.tool_calls) items.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) })
    return items
  })
}

async function* frames(plan: PreparedPlan, context: ProviderExecutionContext): AsyncGenerator<any> {
  const payload = plan.payload as { endpoint: string; body: unknown }
  const key = await context.credential()
  context.signal.throwIfAborted()
  let response: Response
  try {
    response = await fetch(payload.endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify(payload.body), signal: AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]) })
  } catch { throw new ProviderError('transport', 'Model connection failed', { outcome: 'unknown' }) }
  if (!response.ok) {
    const reader = response.body?.getReader()
    let body = ''
    try {
      while (reader && body.length < 16_384) { const chunk = await reader.read(); if (chunk.done) break; body += new TextDecoder().decode(chunk.value).slice(0, 16_384 - body.length) }
    } finally { await reader?.cancel().catch(() => {}) }
    const code = response.status === 401 || response.status === 403 ? 'authentication' : response.status === 429 ? 'rate_limit' : /context.{0,30}(length|limit|window)|maximum context/i.test(body) ? 'context_length' : 'invalid_request'
    const retry = Number(response.headers.get('retry-after'))
    const hint = response.status === 404 ? '请求地址不存在，请检查 Base URL 和 API 格式'
      : response.status === 401 || response.status === 403 ? '鉴权失败，请检查 API Key 和模型访问权限'
      : response.status === 429 ? '请求受限，请检查额度或稍后重试'
      : code === 'context_length' ? '消息超出模型上下文限制'
      : '模型服务拒绝请求，请检查模型名称和请求参数'
    throw new ProviderError(code, `HTTP ${response.status}：${hint}`, { status: response.status, ...(Number.isFinite(retry) && retry > 0 ? { retry_after: retry } : {}) })
  }
  if (!response.body) throw new ProviderError('invalid_response', 'Missing model stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = '', size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) { buffer += decoder.decode(); break }
      size += chunk.value.length
      if (size > 16_000_000) throw new ProviderError('invalid_response', 'Model response exceeds 16 MB')
      buffer += decoder.decode(chunk.value, { stream: true })
      let boundary: RegExpExecArray | null
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        if (data === '[DONE]') return
        yield JSON.parse(data)
      }
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw new ProviderError('transport', 'Model stream interrupted or malformed', { outcome: 'unknown' })
  } finally { await reader.cancel().catch(() => {}) }
}

async function executeChat(plan: PreparedPlan, context: ProviderExecutionContext): Promise<ModelResult> {
  const message = text('assistant', '')
  const calls = new Map<number, { id: string; name: string; arguments: string }>()
  let finish = '', usage: any = null
  for await (const chunk of frames(plan, context)) {
    if (chunk.usage) usage = chunk.usage
    if (!Array.isArray(chunk.choices)) throw new ProviderError('invalid_response', 'Missing model choices')
    for (const choice of chunk.choices) {
      if ((choice.index ?? 0) !== 0) continue
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string') { message.content += delta.content; context.emit({ type: 'text', text: delta.content }) }
      if (typeof delta.reasoning_content === 'string') { message.reasoning += delta.reasoning_content; context.emit({ type: 'reasoning', text: delta.reasoning_content }) }
      for (const call of delta.tool_calls ?? []) {
        if (!Number.isInteger(call.index)) throw new ProviderError('invalid_response', 'Missing tool index')
        const item = calls.get(call.index) ?? { id: '', name: '', arguments: '' }
        if (call.id) item.id = call.id
        item.name += call.function?.name ?? ''
        item.arguments += call.function?.arguments ?? ''
        calls.set(call.index, item)
        if (item.id && call.function?.arguments) context.emit({ type: 'tool_arguments', call: item.id, text: call.function.arguments })
      }
      if (choice.finish_reason) finish = choice.finish_reason
    }
    // Some compatible endpoints finish without a [DONE] frame.
    if (finish) break
  }
  if (!['stop', 'tool_calls'].includes(finish)) throw new ProviderError('invalid_response', 'Incomplete model response')
  try { message.tool_calls = [...calls].sort(([a], [b]) => a - b).map(([, call]) => ({ ...call, arguments: JSON.parse(call.arguments) })) }
  catch { throw new ProviderError('invalid_response', 'Invalid tool arguments') }
  if (finish === 'tool_calls' && !message.tool_calls.length) throw new ProviderError('invalid_response', 'Empty tool call response')
  return { message, continuation: null, usage: usage ? { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } : null, finish_reason: finish }
}

async function executeResponses(plan: PreparedPlan, context: ProviderExecutionContext): Promise<ModelResult> {
  let response: any
  for await (const event of frames(plan, context)) {
    if (event.type === 'response.output_text.delta') context.emit({ type: 'text', text: event.delta })
    if (event.type === 'response.reasoning_summary_text.delta') context.emit({ type: 'reasoning', text: event.delta })
    if (event.type === 'response.function_call_arguments.delta') context.emit({ type: 'tool_arguments', call: event.item_id, text: event.delta })
    if (event.type === 'response.failed' || event.type === 'error') throw new ProviderError('invalid_response', 'Model response failed')
    if (event.type === 'response.incomplete') throw new ProviderError('invalid_response', 'Model response incomplete')
    if (event.type === 'response.completed') { response = event.response; break }
  }
  if (response?.status !== 'completed' || !Array.isArray(response.output)) throw new ProviderError('invalid_response', 'Incomplete model stream')
  const message = text('assistant', '')
  for (const item of response.output) {
    if (item.type === 'function_call') {
      try { message.tool_calls.push({ id: item.call_id, name: item.name, arguments: JSON.parse(item.arguments) }) }
      catch { throw new ProviderError('invalid_response', 'Invalid function call arguments') }
    } else if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text') message.content += part.text
        else if (part.type === 'refusal') message.content += part.refusal
        else throw new ProviderError('unsupported_capability', 'Unsupported response content')
      }
    } else if (item.type === 'reasoning') {
      for (const summary of item.summary ?? []) if (summary.type === 'summary_text') message.reasoning += summary.text
    } else throw new ProviderError('unsupported_capability', 'Hosted tools and non-text output are not enabled')
  }
  // Host supplies the registered owner before this result crosses the RPC boundary.
  return { message, continuation: { provider: '', format: 'openai.responses.items.v1', data: response.output }, usage: response.usage ? { inputTokens: response.usage.input_tokens ?? 0, outputTokens: response.usage.output_tokens ?? 0 } : null, finish_reason: message.tool_calls.length ? 'tool_calls' : 'stop' }
}

export const chatProvider: Provider = { configuration: { label: 'Chat Completions', requestPath: '/chat/completions' }, capabilities: { text: true, tools: true, streaming: true }, prepare: async (input, profile) => prepare(input, profile, false), execute: executeChat }
export const responsesProvider: Provider = { configuration: { label: 'Responses', requestPath: '/responses' }, capabilities: { text: true, tools: true, streaming: true }, prepare: async (input, profile) => prepare(input, profile, true), execute: executeResponses }
