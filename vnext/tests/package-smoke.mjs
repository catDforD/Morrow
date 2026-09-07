import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { environment, start, define, run } from './helpers.mjs'
const env = await environment()
env.binary = resolve(`dist/morrow-next/morrow-next${process.platform === 'win32' ? '.exe' : ''}`)
let server
try {
  server = await start(env)
  await define(server, 'packaged', {
    name: 'test.packaged', description: 'Packaged SDK test', client: null, dependency_lock: '{}',
    host: `import {text} from '@morrow/sdk'; export default ctx=>{ctx.morrow.driver('default',{async run(run){await run.beginStep();await run.append(text('assistant','packaged SDK works'));await run.endStep()}})}`,
  })
  const state = await run(server, 'packaged', 'hello')
  assert.equal(state.last_outcome, 'completed', server.errors())
  assert.equal(state.nodes[state.surface.at(-1)].message.content, 'packaged SDK works')
  assert.equal((await fetch(server.url)).status, 200)
  console.log('packaged Rust + Node + SDK + Web smoke passed')
} finally { if (server) await server.stop(); await env.dispose() }
