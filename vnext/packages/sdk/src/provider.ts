import type { ModelInput, ModelResult, PreparedPlan } from './protocol.js'

export interface PublicProfile {
  id: string
  provider: string
  model: string
  endpoint: string
  baseUrl?: string
  options: Record<string, unknown>
}
export interface ProviderCapabilities { text: boolean; tools: boolean; streaming: boolean }
export type ModelProgress =
  | { type: 'text' | 'reasoning'; text: string }
  | { type: 'tool_arguments'; call: string; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'gap' }
export interface ProviderExecutionContext {
  signal: AbortSignal
  credential(): Promise<string>
  emit(event: ModelProgress): void
}
export interface Provider {
  capabilities: ProviderCapabilities
  configuration?: { label: string; requestPath: string }
  prepare(input: Readonly<ModelInput>, profile: Readonly<PublicProfile>): Promise<PreparedPlan>
  execute(plan: Readonly<PreparedPlan>, context: ProviderExecutionContext): Promise<ModelResult>
}

export class ProviderError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) { super(message) }
}

// Only the Node compatibility adapter knows the old callback's chat-shaped body.
export function legacyBody(input: ModelInput) {
  if (input.continuations.some(Boolean)) throw new ProviderError('unsupported_capability', 'Chat compatibility cannot represent provider continuation')
  const messages: any[] = input.header.system ? [{ role: 'system', content: input.header.system }] : []
  for (const message of input.messages) {
    const wire: any = { role: message.role, content: message.content }
    if (message.reasoning) wire.reasoning_content = message.reasoning
    if (message.tool_call_id) wire.tool_call_id = message.tool_call_id
    if (message.tool_calls.length) wire.tool_calls = message.tool_calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }))
    messages.push(wire)
  }
  return { ...(input.header.parameters as object), model: input.header.model, messages, stream: true,
    ...(input.header.tools.length ? { tools: input.header.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}) }
}
