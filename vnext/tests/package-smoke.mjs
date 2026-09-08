import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { environment, start, define, run } from './helpers.mjs'
const env = await environment()
env.launcher = resolve('dist/morrow-next/packages/host/dist/launcher.js')
env.node = resolve(`dist/morrow-next/node${process.platform === 'win32' ? '.exe' : ''}`)
if (process.platform !== 'win32') env.command = [resolve('dist/morrow-next/morrow'), 'server', '--home', env.home, '--port', '0']
let server
try {
  server = await start(env)
  const settings = await server.action('packaged', 'invoke', { plugin: 'morrow.settings', hash: '1', method: 'profiles.get' })
  assert.ok(settings.providers.includes('openai-chat'))
  await define(server, 'packaged', {
    name: 'test.packaged', description: 'Packaged SDK test', client: null, dependency_lock: '{}',
    host: `import {text} from '@morrow/sdk'; export default ctx=>{
      ctx.morrow.policy('00-provider',async(_run,p,next)=>{p.header.provider='packaged';await next()});
      ctx.morrow.provider('packaged',{capabilities:{text:true,tools:true,streaming:true},
        async prepare(){return {format:'packaged.test.v1',payload:{answer:'packaged SDK works'}}},
        async execute(plan){return {message:text('assistant',plan.payload.answer),continuation:null,usage:null,finish_reason:'stop'}}});
    }`,
  })
  const state = await run(server, 'packaged', 'hello')
  assert.equal(state.last_outcome, 'completed', server.errors())
  assert.equal(state.nodes[state.surface.at(-1)].message.content, 'packaged SDK works')
  assert.equal((await fetch(server.url)).status, 200)
  console.log('packaged Rust + Node + SDK + Web smoke passed')
} finally { if (server) await server.stop(); await env.dispose() }
