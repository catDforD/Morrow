import WebSocket from 'ws'
import type { Rpc } from '@morrow/sdk'
import { ProviderError } from '@morrow/sdk'

export class Peer implements Rpc {
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>()
  handle: (method: string, params: any) => Promise<unknown> = async () => { throw new Error('host not initialized') }
  constructor(readonly socket: WebSocket, readonly sanitize: <T>(value: T) => T = value => value) {
    socket.on('message', bytes => {
      let message: any
      try { message = JSON.parse(bytes.toString()) } catch { socket.close(); return }
      if (message.jsonrpc !== '2.0') { socket.close(); return }
      if (message.method) {
        Promise.resolve().then(() => this.handle(message.method, message.params)).then(
          result => { if (message.id) this.send({ id: message.id, result: result ?? null }, message.method === 'client.invoke') },
          error => { if (message.id) this.send({ id: message.id, error: { code: -32000, message: String(error?.message ?? error), data: error instanceof ProviderError ? { code: error.code, message: error.message, details: error.details } : null } }) },
        )
      } else {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(message.error.data?.code ? new ProviderError(message.error.data.code, message.error.data.message, message.error.data.details) : new Error(message.error.message))
        else pending.resolve(message.result)
      }
    })
    socket.on('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('kernel disconnected'))
      this.pending.clear()
    })
  }
  private send(value: object, transient = false) {
    // UI method replies are transient (for example an explicitly revealed key); facts and model RPC remain redacted.
    const message = { jsonrpc: '2.0', ...value }
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(transient ? message : this.sanitize(message)))
  }
  async call<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('kernel disconnected')
    const id = crypto.randomUUID()
    let abort: () => void = () => {}
    try {
      return await new Promise<T>((resolve, reject) => {
        abort = () => { this.pending.delete(id); reject(new Error('run cancelled')) }
        signal?.addEventListener('abort', abort, { once: true })
        this.pending.set(id, { resolve, reject })
        this.send({ id, method, params })
      })
    } finally { signal?.removeEventListener('abort', abort); this.pending.delete(id) }
  }
}
