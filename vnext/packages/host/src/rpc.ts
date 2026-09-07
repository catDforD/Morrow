import WebSocket from 'ws'
import type { Rpc } from '@morrow/sdk'

export class Peer implements Rpc {
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>()
  handle: (method: string, params: any) => Promise<unknown> = async () => { throw new Error('host not initialized') }
  constructor(readonly socket: WebSocket) {
    socket.on('message', bytes => {
      let message: any
      try { message = JSON.parse(bytes.toString()) } catch { socket.close(); return }
      if (message.jsonrpc !== '2.0') { socket.close(); return }
      if (message.method) {
        Promise.resolve().then(() => this.handle(message.method, message.params)).then(
          result => { if (message.id) this.send({ id: message.id, result: result ?? null }) },
          error => { if (message.id) this.send({ id: message.id, error: { code: -32000, message: String(error?.message ?? error) } }); else console.error(error) },
        )
      } else {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
      }
    })
    socket.on('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('kernel disconnected'))
      this.pending.clear()
    })
  }
  private send(value: object) { if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ jsonrpc: '2.0', ...value })) }
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
