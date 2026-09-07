import WebSocket from 'ws'
import { registerHooks } from 'node:module'
import { Peer } from './rpc.js'
import { Host } from './loader.js'

// Trusted artifacts can import the pinned SDK and Cordis without bundling duplicate runtimes.
const shared = new Map(['@morrow/sdk', '@deepseek-ai/cordis'].map(name => [name,
  process.env.MORROW_BUNDLED === '1' ? new URL(name === '@morrow/sdk' ? './sdk.js' : './cordis.js', import.meta.url).href : import.meta.resolve(name),
]))
registerHooks({ resolve(specifier, context, next) {
  const url = shared.get(specifier)
  return url ? { url, shortCircuit: true } : next(specifier, context)
} })

const socket = new WebSocket(process.env.MORROW_HOST_URL!, { headers: { authorization: `Bearer ${process.env.MORROW_HOST_TOKEN}` } })
const peer = new Peer(socket)
await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
const hello = await peer.call<{ epoch: string; protocol: number }>('host.ready', {})
if (hello.protocol !== 1) throw new Error('incompatible kernel protocol')
const host = new Host(peer, hello.epoch, process.env.MORROW_NEXT_HOME!)
peer.handle = async (method, params) => {
  switch (method) {
    case 'driver.run': return host.run(params)
    case 'run.cancel': return host.cancel(params.run)
    case 'plugins.changed': return host.changed(params.session)
    case 'registration.invoke': return host.invoke(params.registration, params.context, params.input)
    case 'client.invoke': return host.client(params)
    case 'session.resume': return host.resume(params.session)
    default: throw new Error(`unknown host method ${method}`)
  }
}
socket.on('close', () => process.exit(0))
