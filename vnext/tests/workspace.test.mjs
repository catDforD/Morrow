import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, realpath } from 'node:fs/promises'
import { join, toNamespacedPath } from 'node:path'
import { environment, start, define, run } from './helpers.mjs'

const driver = label => ({ name: 'test.workspace', description: '', client: null, dependency_lock: '{}', host: `export default ctx => ctx.morrow.driver('default', { async run(run) { await run.beginStep(); await run.append({role:'assistant',content:${JSON.stringify(label)},reasoning:'',tool_calls:[],tool_call_id:null}); await run.endStep() } })` })
const folder = async env => join(env.home, 'sessions', createHash('sha256').update(toNamespacedPath(await realpath(env.workspace))).digest('hex'))

test('projects sharing a home can use identical session names and keep their own history and plugins', async () => {
  const env = await environment(); let first, second
  const other = { ...env, workspace: join(env.directory, 'other-project') }
  await mkdir(other.workspace)
  try {
    first = await start(env); second = await start(other)
    for (const name of ['default', 'new']) {
      await define(first, name, driver('first project'))
      await define(second, name, driver('second project'))
      assert.equal((await run(first, name, 'hello first')).last_outcome, 'completed')
      assert.equal((await run(second, name, 'hello second')).last_outcome, 'completed')
      assert.notDeepEqual((await first.state(name)).bindings, (await second.state(name)).bindings)
      assert.ok(!JSON.stringify(await first.api(`/session/${name}/facts`)).includes('hello second'))
      assert.ok(!JSON.stringify(await second.api(`/session/${name}/facts`)).includes('hello first'))
    }
    await first.state('first-only'); await second.state('second-only')
    assert.deepEqual(await first.api('/sessions'), ['default', 'first-only', 'new'])
    assert.deepEqual(await second.api('/sessions'), ['default', 'new', 'second-only'])
    const config = { id: 'shared', name: 'Shared provider', provider: 'openai-chat', baseUrl: 'http://localhost:10001/v1', model: 'shared-model', options: {} }
    await first.action('default', 'invoke', { plugin: 'morrow.settings', hash: '1', method: 'profiles.save', input: config })
    await second.stop(); second = await start(other)
    assert.ok((await second.action('default', 'invoke', { plugin: 'morrow.settings', hash: '1', method: 'profiles.get' })).profiles.some(profile => profile.id === 'shared'))
    const restored = await second.state('new')
    assert.equal(restored.nodes[restored.surface.at(-1)].message.content, 'second project')
  } finally { if (first) await first.stop(); if (second) await second.stop(); await env.dispose() }
})

test('old flat logs stay readable in their project without blocking same-named sessions elsewhere', async () => {
  const env = await environment(); let first, second
  const other = { ...env, workspace: join(env.directory, 'other-project') }
  await mkdir(other.workspace)
  try {
    first = await start(env)
    await define(first, 'new', driver('old project history'))
    await run(first, 'new', 'old message')
    await first.stop(); first = undefined
    const flat = join(env.home, 'sessions/new.jsonl')
    await rename(join(await folder(env), 'new.jsonl'), flat)
    const original = await readFile(flat, 'utf8')
    // Keep the legacy writer open while the other project uses the same name.
    first = await start(env); second = await start(other)
    assert.ok((await first.api('/sessions')).includes('new'))
    const old = await first.state('new')
    assert.equal(old.nodes[old.surface.at(-1)].message.content, 'old project history')
    assert.deepEqual(await second.api('/sessions'), [])
    assert.equal((await second.state('new')).surface.length, 0)
    assert.equal(await readFile(flat, 'utf8'), original)
    await define(second, 'new', driver('new project history'))
    await run(second, 'new', 'another project')
    assert.equal(await readFile(flat, 'utf8'), original)
    await first.stop(); first = undefined
    const after = await readFile(flat, 'utf8')
    await second.stop(); second = await start(other)
    assert.equal((await second.state('new')).workspace, toNamespacedPath(await realpath(other.workspace)))
    assert.equal(await readFile(flat, 'utf8'), after)
  } finally { if (first) await first.stop(); if (second) await second.stop(); await env.dispose() }
})
