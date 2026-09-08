import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'

export interface McpConfig { name: string; command?: string; args?: string[]; url?: string; headers?: Record<string, string> }

/** MCP transports run in the trusted host; every tools/call still enters Rust's effect/approval path. */
export class McpClient {
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>()
  private session?: string
  constructor(private config: McpConfig) {}
  async start() {
    if (this.config.command) {
      this.child = spawn(this.config.command, this.config.args ?? [], { stdio: 'pipe', env: process.env })
      this.child.stderr.on('data', data => process.stderr.write(data))
      createInterface({ input: this.child.stdout }).on('line', line => {
        let message: any
        try { message = JSON.parse(line) } catch { this.close(); return }
        if (message.id != null && message.method) {
          this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client method unsupported' } })}\n`)
          return
        }
        const pending = this.pending.get(String(message.id))
        if (!pending) return
        this.pending.delete(String(message.id))
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
      })
      this.child.on('error', error => this.fail(error))
      this.child.on('exit', () => this.fail(new Error('MCP server exited')))
    }
    const result = await this.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'morrow-next', version: '0.1.0' } })
    if (!result?.protocolVersion) throw new Error('invalid MCP initialization')
    await this.notify('notifications/initialized', {})
  }
  private fail(error: Error) { for (const value of this.pending.values()) value.reject(error); this.pending.clear() }
  close() { this.child?.kill(); this.fail(new Error('MCP client disposed')) }
  private async notify(method: string, params: unknown) {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params })
    if (this.child) { this.child.stdin.write(body + '\n'); return }
    await this.http(body)
  }
  private async http(body: string, signal?: AbortSignal) {
    if (!this.config.url) throw new Error('MCP command or URL is required')
    const response = await fetch(this.config.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26', ...(this.session ? { 'mcp-session-id': this.session } : {}), ...this.config.headers }, body, signal })
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`)
    this.session = response.headers.get('mcp-session-id') ?? this.session
    if (response.status === 202 || response.status === 204) return
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      const reader = response.body!.getReader(), decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) throw new Error('MCP stream ended before result')
          buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n')
          if (buffer.length > 8_000_000) throw new Error('MCP response exceeds 8 MB')
          let end
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
            if (!data) continue
            const message = JSON.parse(data)
            if (message.id != null && !message.method) return message
          }
        }
      } finally { await reader.cancel() }
    }
    return response.json()
  }
  async call(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    const id = crypto.randomUUID()
    const deadline = AbortSignal.timeout(120_000)
    const abort = signal ? AbortSignal.any([signal, deadline]) : deadline
    abort.throwIfAborted()
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    if (!this.child) {
      const response = await this.http(body, abort)
      if (response?.error) throw new Error(response.error.message)
      return response?.result
    }
    let cancel: () => void = () => {}
    try {
      return await new Promise((resolve, reject) => {
        cancel = () => { this.pending.delete(id); void this.notify('notifications/cancelled', { requestId: id, reason: 'cancelled' }); reject(new Error('MCP request cancelled; outcome unknown')) }
        abort.addEventListener('abort', cancel, { once: true })
        this.pending.set(id, { resolve, reject })
        this.child!.stdin.write(body + '\n')
      })
    } finally { this.pending.delete(id); abort.removeEventListener('abort', cancel) }
  }
}

export async function mcp(ctx: Context, config: McpConfig) {
  const client = new McpClient(config)
  ctx.effect(() => () => client.close())
  await client.start()
  let cursor: string | undefined
  do {
    const result = await client.call('tools/list', cursor ? { cursor } : {})
    for (const tool of result.tools ?? []) {
      ctx.morrow.tool({ name: `${config.name}__${tool.name}`, description: tool.description ?? tool.name, parameters: tool.inputSchema, approval: tool.annotations?.readOnlyHint !== true }, (args, run) => client.call('tools/call', { name: tool.name, arguments: args }, run.signal))
    }
    cursor = result.nextCursor
  } while (cursor)
}
