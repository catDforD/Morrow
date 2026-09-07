import assert from 'node:assert/strict'
import { environment, start, define, run, until } from './helpers.mjs'
import { scripted, stats } from './fixtures.mjs'

const env = await environment()
let server
let cases = 0
const check = (name, fn) => Promise.resolve().then(fn).then(() => { cases++; console.log(`ok ${cases} - ${name}`) })
try {
  server = await start(env)
  await define(server, 'work', scripted)
  await check('Rust → Cordis driver → Rust prepared request → Node provider', async () => {
    const state = await run(server, 'work', 'hello', 'hello-once')
    assert.equal(state.last_outcome, 'completed', server.errors() + JSON.stringify((await server.api('/session/work/facts')).slice(-4)))
    assert.equal(Object.keys(state.requests).length, 1)
    const request = Object.values(state.requests)[0]
    const audit = await server.api(`/session/work/request/${request.id}`)
    assert.deepEqual(audit.reconstructed, request.body)
  })
  await check('duplicate submission cannot repeat effects', async () => {
    const before = await server.state('work')
    const duplicate = await server.action('work', 'submit', { text: 'hello', submission: 'hello-once' })
    assert.equal(duplicate.duplicate, true)
    assert.equal((await server.state('work')).seq, before.seq)
  })
  await check('parallel tools settle to ordered context with nested RPC', async () => {
    const state = await run(server, 'work', 'parallel')
    assert.equal(state.last_outcome, 'completed', server.errors() + JSON.stringify((await server.api('/session/work/facts')).slice(-4)))
    const messages = state.surface.map(id => state.nodes[id].message)
    assert.deepEqual(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['a', 'b'])
  })
  let hash
  await check('model defines dual plugin without activating its code', async () => {
    const state = await run(server, 'work', 'define stats')
    assert.equal(state.last_outcome, 'completed', server.errors() + JSON.stringify((await server.api('/session/work/facts')).slice(-4)))
    const version = Object.values(state.plugins).find(v => v.manifest.name === stats.name)
    hash = version.hash
    assert.equal(state.trusted.includes(hash), false)
    await assert.rejects(server.action('work', 'activate', { hash }), /trusted/)
  })
  await check('trusted session plugin calls Rust SDK tools and persists panel state', async () => {
    await server.action('work', 'trust', { hash })
    await server.action('work', 'activate', { hash })
    const state = await run(server, 'work', 'run stats')
    assert.equal(state.last_outcome, 'completed', server.errors() + JSON.stringify((await server.api('/session/work/facts')).slice(-4)))
    assert.deepEqual(state.plugin_state[stats.name].stats, { files: 1, lines: 1, runs: 1 })
    assert.equal((await server.api('/session/work/facts')).findLast(r => r.fact.type === 'request_prepared').fact.request.header.tools.some(t => t.name === 'project_stats'), true)
    assert.deepEqual(await server.action('work', 'invoke', { plugin: stats.name, hash, method: 'stats.get' }), state.plugin_state[stats.name].stats)
  })
  await check('session plugin isolation and stop retract registrations', async () => {
    await define(server, 'sibling', scripted)
    const sibling = await run(server, 'sibling', 'hello')
    assert.equal(Object.values(sibling.requests)[0].header.tools.some(t => t.name === 'project_stats'), false)
    await server.action('work', 'stop', { hash })
    const state = await run(server, 'work', 'hello')
    assert.equal((await server.api('/session/work/facts')).findLast(r => r.fact.type === 'request_prepared').fact.request.header.tools.some(t => t.name === 'project_stats'), false)
    await server.action('work', 'activate', { hash })
  })
  await check('approval decision persists before tool dispatch', async () => {
    await server.action('work', 'submit', { text: 'shell', submission: 'shell-once' })
    const approval = await until(async () => Object.entries((await server.state('work')).approvals).find(([, a]) => a.approved === null))
    await server.action('work', 'approve', { id: approval[0], approved: false })
    await until(async () => (await server.state('work')).run === null)
    const state = await server.state('work')
    assert.equal(Object.values(state.effects).some(e => e.name === 'shell'), false)
  })
  await check('cancelled model has uncertain effect and retained input', async () => {
    await server.action('work', 'submit', { text: 'slow', submission: 'slow-once' })
    await until(async () => Object.values((await server.state('work')).effects).some(e => e.outcome === null))
    await server.action('work', 'cancel')
    const state = await until(async () => { const state = await server.state('work'); return state.run === null && state })
    assert.ok(Object.values(state.effects).some(e => e.outcome === 'unknown'))
    assert.ok(state.surface.some(id => state.nodes[id].message.content === 'slow'))
  })
  await check('restart restores exact binding/state without replaying statistics task', async () => {
    const before = (await server.state('work')).plugin_state[stats.name]
    await server.stop()
    server = await start(env)
    assert.deepEqual((await server.state('work')).plugin_state[stats.name], before)
    await run(server, 'work', 'hello after restart')
    assert.deepEqual((await server.state('work')).plugin_state[stats.name], before)
  })
  await check('all prepared requests exactly reconstruct after restart', async () => {
    const state = await server.state('work')
    for (const request of Object.values(state.requests)) {
      const audit = await server.api(`/session/work/request/${request.id}`)
      assert.deepEqual(audit.reconstructed, request.body)
    }
  })
  await check('compaction uses an auditable summary request and balanced replacement', async () => {
    const state = await run(server, 'work', 'hello ' + 'x'.repeat(61000))
    assert.equal(state.last_outcome, 'completed')
    const records = await server.api('/session/work/facts')
    const replacement = records.findLast(r => r.fact.type === 'surface_replaced').fact
    assert.ok(replacement.covers.length > 1)
    assert.equal(state.requests[replacement.source_request].purpose, 'summary')
    for (const request of Object.values(state.requests)) assert.deepEqual((await server.api(`/session/work/request/${request.id}`)).reconstructed, request.body)
  })
  await check('malformed model tool calls fail before entering context', async () => {
    const state = await run(server, 'sibling', 'malformed')
    assert.equal(state.last_outcome, 'failed')
    assert.ok(state.surface.every(id => state.nodes[id].message.tool_calls.length === 0))
  })
  await check('unknown tool becomes an explicit result and allows continuation', async () => {
    const state = await run(server, 'sibling', 'unknown')
    assert.equal(state.last_outcome, 'completed')
    assert.ok(state.surface.some(id => state.nodes[id].message.content.includes('tool missing')))
  })
  await check('tool-triggered activation returns a pending receipt and changes only the next step', async () => {
    await server.action('work', 'stop', { hash })
    await define(server, 'work', { name:'test.lifecycle',description:'Lifecycle fixture',client:null,dependency_lock:'{}',host:`export default ctx => {ctx.morrow.tool({name:'activate_stats',description:'',parameters:{type:'object'},approval:false},(_input,run)=>run.activate(${JSON.stringify(hash)}))}` })
    const state = await run(server, 'work', 'activate stats')
    assert.equal(state.last_outcome, 'completed')
    const requests = (await server.api('/session/work/facts')).filter(r => r.fact.type === 'request_prepared' && r.fact.request.purpose === 'main').slice(-2).map(r => r.fact.request)
    assert.equal(requests[0].header.tools.some(t => t.name === 'project_stats'), false)
    assert.equal(requests[1].header.tools.some(t => t.name === 'project_stats'), true)
    assert.ok(state.surface.some(id => state.nodes[id].message.content.includes('next_step')))
  })
  await check('subagents use the same kernel with separate history and inherited bindings', async () => {
    const state = await run(server, 'sibling', 'spawn child')
    assert.equal(state.last_outcome, 'completed')
    const spawned = (await server.api('/session/sibling/facts')).findLast(r => r.fact.type === 'plugin_event' && r.fact.name === 'spawned')
    const child = await server.state(spawned.fact.data.child)
    assert.equal(child.parent, 'sibling')
    assert.equal(child.last_outcome, 'completed')
    assert.equal(child.surface.length, 2)
  })
  await check('custom drivers replace the execution loop', async () => {
    await define(server, 'custom', {name:'test.driver',description:'Custom driver',client:null,dependency_lock:'{}',host:`export default ctx=>{ctx.morrow.driver('default',{async run(run){await run.beginStep();await run.append({role:'assistant',content:'custom driver',reasoning:'',tool_calls:[],tool_call_id:null});await run.endStep()}})}`})
    const state = await run(server, 'custom', 'hello')
    assert.equal(state.last_outcome, 'completed')
    assert.equal(Object.keys(state.requests).length, 0)
    assert.equal(state.nodes[state.surface.at(-1)].message.content, 'custom driver')
  })
  await check('host crash settles in-flight tools as unknown and never repeats them', async () => {
    await define(server, 'sibling', {name:'test.crash',description:'Crash fixture',client:null,dependency_lock:'{}',host:`export default ctx=>{ctx.morrow.tool({name:'crash_host',description:'',parameters:{type:'object'},approval:false},()=>process.exit(23))}`})
    const state = await run(server, 'sibling', 'crash host')
    assert.notEqual(state.last_outcome, 'completed')
    const effects = Object.values(state.effects).filter(e => e.name === 'crash_host')
    assert.equal(effects.length, 1)
    assert.equal(effects[0].outcome, 'unknown')
    await until(async () => { try { await server.action('sibling', 'resume'); return true } catch { return false } })
    assert.equal((await run(server, 'sibling', 'hello recovered')).last_outcome, 'completed')
    assert.equal(Object.values((await server.state('sibling')).effects).filter(e => e.name === 'crash_host').length, 1)
  })
  console.log(`${cases} cross-language scenarios passed`)
} finally { if (server) await server.stop(); await env.dispose() }
