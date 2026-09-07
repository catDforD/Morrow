import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Contributions, Morrow, RunContext } from '../packages/sdk/dist/index.js'

const owner = scope => ({ plugin: 'test.plugin', version: 'hash', scope, epoch: 'epoch', generation: 1 })
const definition = { name: 'read', description: '', parameters: {}, approval: false }

test('Cordis owns registrations, scopes shadow ancestors, and snapshots retain callbacks', async () => {
  const ctx = new Context(), registry = new Contributions()
  new Morrow(ctx, registry)
  const app = await ctx.extend({ morrowOwner: owner('application') }).plugin(ctx => ctx.morrow.tool(definition, () => 'app'))
  const session = await ctx.extend({ morrowOwner: owner('session:a') }).plugin(ctx => ctx.morrow.tool(definition, () => 'session'))
  const pinned = registry.snapshot(['application', 'session:a'])
  assert.equal(await pinned[0].handler(), 'session')
  assert.equal(await registry.snapshot(['application', 'session:b'])[0].handler(), 'app')
  await session.dispose()
  assert.equal(await registry.snapshot(['application', 'session:a'])[0].handler(), 'app')
  assert.equal(await pinned[0].handler(), 'session')
  await app.dispose()
  assert.equal(registry.snapshot(['application']).length, 0)
})

test('Cordis DI parks missing dependencies and cleans consumer effects when provider stops', async () => {
  const ctx = new Context(), events = []
  const consumer = await ctx.plugin({ inject: ['example'], apply(ctx) {
    events.push(ctx.get('example').value)
    ctx.effect(() => () => events.push('released'))
  } })
  assert.deepEqual(events, [])
  const provider = await ctx.plugin(ctx => ctx.provide('example', { value: 'ready' }))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(events, ['ready'])
  await provider.dispose()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(events, ['ready', 'released'])
  await consumer.dispose()
})

test('plugin policy wraps preparation and temporary context before model call', async () => {
  const ctx = new Context(), registry = new Contributions(), calls = []
  new Morrow(ctx, registry)
  await ctx.extend({ morrowOwner: owner('application') }).plugin(ctx => ctx.morrow.policy('prompt', async (run, prep, next) => {
    calls.push('before'); prep.header.system = 'effective prompt'; await next(); calls.push('after')
  }))
  const run = new RunContext({ call: async () => ({}) }, 's', 'r', 'epoch', new AbortController().signal, 'model', { begin: async () => [], end: async () => {} })
  run.entries = registry.snapshot(['application'])
  const result = await run.prepare({ header: { model: 'm', provider: 'p', system: '', tools: [], parameters: {} }, temporary: [] })
  assert.equal(result.header.system, 'effective prompt')
  assert.deepEqual(calls, ['before', 'after'])
  await ctx.fiber.dispose()
})
