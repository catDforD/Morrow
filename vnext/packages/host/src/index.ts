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

export async function startHost(url: string, token: string, home: string, profiles: import('./provider-service.js').Profiles) {
  const socket = new WebSocket(url.replace(/^http/, 'ws') + '/host', { headers: { authorization: 'Bearer ' + token } })
  const peer = new Peer(socket, value => profiles.sanitize(value))
  let host: Host
  let initialized!: () => void
  const initialization = new Promise<void>(resolve => { initialized = resolve })
  peer.handle = async (method, params) => {
    await initialization
    switch (method) {
      case 'driver.run': return host.run(params)
      case 'provider.prepare': return host.provider('prepare', params)
      case 'provider.execute': return host.provider('execute', params)
      case 'profiles.list': return profiles.list()
      case 'run.cancel': return host.cancel(params.run)
      case 'plugins.changed': return host.changed(params.session)
      case 'registration.invoke': return host.invoke(params.registration, params.context, params.input)
      case 'client.invoke': return host.client(params)
      case 'session.resume': return host.resume(params.session)
      default: throw new Error('unknown host method ' + method)
    }
  }
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const hello = await peer.call<{ epoch: string; protocol: number }>('host.ready', {})
  if (hello.protocol !== 2) { socket.close(); throw new Error('incompatible kernel protocol') }
  host = new Host(peer, hello.epoch, home, profiles)
  initialized()
  socket.on('close', () => host.cancelAll())
  return { host, socket }
}
