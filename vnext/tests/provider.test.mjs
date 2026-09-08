import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, stat, realpath } from 'node:fs/promises'
import { join, toNamespacedPath } from 'node:path'
import { chatProvider, responsesProvider } from '../packages/host/dist/providers.js'
import { Profiles, ProviderService } from '../packages/host/dist/provider-service.js'
import { kernelEnvironment } from '../packages/host/dist/launcher.js'
import { text, legacyBody } from '../packages/sdk/dist/index.js'
import { environment, start, define, run, until, root } from './helpers.mjs'

async function cli(env, args, stdin = '') {
  const child = spawn(process.execPath, [join(root, 'packages/host/dist/launcher.js'), '--home', env.home, '--workspace', env.workspace, ...args], { env: env.environment ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  child.stdin.end(stdin)
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
  try { const [code] = await once(child, 'exit'); assert.equal(code, 0, stderr); return stdout }
  finally { clearTimeout(timer) }
}

async function http(handler) {
  const errors = [], requests = []
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      requests.push({ body, authorization: req.headers.authorization, path: req.url })
      await handler(body, res, requests.length)
    } catch (error) { errors.push(error); res.writeHead(500); res.end('fixture error') }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { endpoint: 'http://127.0.0.1:' + server.address().port, requests, errors, async stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
const event = (res, data) => res.write('data: ' + JSON.stringify(data) + '\n\n')
const input = () => ({ header: { provider: 'openai-chat', model: 'test', system: 'system', tools: [], parameters: {} }, messages: [text('user', 'hello')], continuations: [null] })
const context = { signal: new AbortController().signal, credential: async () => 'test-secret', emit() {} }
const profile = endpoint => ({ id: 'test', provider: 'openai-chat', model: 'test', endpoint, options: {} })

test('protocol adapters append paths to Base URLs and preserve legacy exact endpoints', async () => {
  for (const [adapter, suffix] of [[chatProvider, '/chat/completions'], [responsesProvider, '/responses']]) {
    for (const baseUrl of ['https://example.com/v1', 'https://example.com/api/coding/v3/', 'https://example.com/custom/prefix///']) {
      const plan = await adapter.prepare(input(), { ...profile('legacy'), baseUrl })
      assert.equal(plan.payload.endpoint, baseUrl.replace(/\/+$/, '') + suffix)
    }
    const endpoint = 'https://example.com/nonstandard-model-route'
    assert.equal((await adapter.prepare(input(), profile(endpoint))).payload.endpoint, endpoint)
  }
})

test('chat streams preserve fragmented UTF-8 and fragmented tool arguments', async () => {
  const service = await http(async (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const bytes = Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: '你好', tool_calls: [{ index: 0, id: 'call', function: { name: 'read_file', arguments: '{"path":' } }] } }] }) + '\n\n' + 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: 'tool_calls' }] }) + '\n\n')
    for (const byte of bytes) res.write(Buffer.from([byte]))
    res.end()
  })
  try {
    const deltas = []
    const plan = await chatProvider.prepare(input(), profile(service.endpoint))
    const result = await chatProvider.execute(plan, { ...context, emit: e => deltas.push(e) })
    assert.equal(result.message.content, '你好')
    assert.deepEqual(result.message.tool_calls[0], { id: 'call', name: 'read_file', arguments: { path: 'a.txt' } })
    assert.ok(deltas.some(e => e.type === 'text'))
    assert.deepEqual(service.requests[0].body, plan.payload.body)
  } finally { await service.stop() }
})

test('truncated and length-limited chat responses are rejected without hidden retry', async () => {
  for (const finish_reason of [null, 'length']) {
    const service = await http(async (_body, res) => { event(res, { choices: [{ delta: { content: 'partial' }, finish_reason }] }); res.end() })
    try {
      await assert.rejects(chatProvider.execute(await chatProvider.prepare(input(), profile(service.endpoint)), context), /Incomplete/)
      assert.equal(service.requests.length, 1)
    } finally { await service.stop() }
  }
})

test('provider-specific options cannot override input or enable untracked remote state', async () => {
  for (const parameters of [{ input: [] }, { previous_response_id: 'remote' }, { store: true }, { tools: [] }]) {
    await assert.rejects(responsesProvider.prepare({ ...input(), header: { ...input().header, parameters } }, profile('http://localhost')), error => ['invalid_request', 'unsupported_capability'].includes(error.code))
  }
})

test('switching providers cannot silently discard opaque continuation', async () => {
  const previous = { ...input(), continuations: [{ provider: 'openai-responses', format: 'openai.responses.items.v1', data: [] }] }
  assert.throws(() => legacyBody(previous), error => error.code === 'unsupported_capability')
  for (const adapter of [chatProvider, responsesProvider]) {
    await assert.rejects(adapter.prepare(previous, profile('http://localhost')), error => error.code === 'unsupported_capability')
  }
})

test('HTTP errors stay typed and exclude server-provided credentials', async () => {
  const service = await http(async (_body, res) => { res.writeHead(400); res.end('maximum context length exceeded: test-secret') })
  try {
    await assert.rejects(chatProvider.execute(await chatProvider.prepare(input(), profile(service.endpoint)), context), error => error.code === 'context_length' && !JSON.stringify(error).includes('test-secret'))
    assert.equal(service.requests.length, 1)
  } finally { await service.stop() }
})

test('HTTP failures explain status codes without displaying the remote error body', async () => {
  for (const [status, hint] of [[404, 'Base URL'], [401, 'API Key'], [429, '额度']]) {
    const service = await http(async (_body, res) => { res.writeHead(status); res.end('private server detail: test-secret') })
    try {
      await assert.rejects(chatProvider.execute(await chatProvider.prepare(input(), profile(service.endpoint)), context), error => {
        assert.equal(error.details.status, status)
        assert.ok(error.message.includes(`HTTP ${status}`))
        assert.ok(error.message.includes(hint))
        assert.ok(!error.message.includes('private server detail'))
        assert.ok(!JSON.stringify(error).includes('test-secret'))
        return true
      })
    } finally { await service.stop() }
  }
})

test('legacy version prefixes load as Base URLs while complete endpoints remain exact', async () => {
  const env = await environment()
  try {
    await mkdir(env.home, { recursive: true })
    for (const endpoint of ['https://example.com/v1', 'https://example.com/api/coding/v3/']) {
      await writeFile(join(env.home, 'providers.json'), JSON.stringify({ defaultProfile: 'ark', profiles: { ark: { provider: 'openai-responses', model: 'glm-5.3-flash', endpoint, options: {}, credentialRef: 'env:OPENAI_API_KEY' } } }))
      const profiles = new Profiles(env.home, { OPENAI_API_KEY: 'legacy-profile-key' }); await profiles.load()
      const selected = profiles.public('ark')
      assert.equal(selected.baseUrl, endpoint.replace(/\/+$/, ''))
      assert.equal(selected.model, 'glm-5.3-flash')
      assert.equal(await profiles.reveal('ark'), 'legacy-profile-key')
      for (const [adapter, path] of [[chatProvider, '/chat/completions'], [responsesProvider, '/responses']]) {
        assert.equal((await adapter.prepare(input(), selected)).payload.endpoint, selected.baseUrl + path)
      }
    }
    const profiles = new Profiles(env.home, {}); await profiles.load()
    for (const endpoint of ['https://example.com/v1/responses', 'https://example.com/custom-route']) {
      await profiles.save({ id: 'exact', provider: 'openai-responses', model: 'model', endpoint, options: {} })
      assert.equal(profiles.public('exact').baseUrl, undefined)
      assert.equal((await responsesProvider.prepare(input(), profiles.public('exact'))).payload.endpoint, endpoint)
    }
  } finally { await env.dispose() }
})

test('prepare/execute pins plans, deduplicates execution and bounds progress RPC', async () => {
  const env = await environment()
  try {
    const profiles = new Profiles(env.home, { OPENAI_API_KEY: 'sentinel-provider-key' }); await profiles.load()
    const service = new ProviderService(profiles)
    let sent = 0, release
    const wait = new Promise(resolve => { release = resolve })
    const entry = { registration: { kind: 'model', name: 'openai-chat' }, signal: context.signal, provider: {
      capabilities: { text: true, tools: true, streaming: true },
      prepare: async () => ({ format: 'third-protocol.v1', payload: { commands: ['hello'] } }),
      execute: async (plan, ctx) => { sent++; assert.ok(Object.isFrozen(plan)); for (let i = 0; i < 2000; i++) ctx.emit({ type: 'text', text: 'hello' }); await wait; return { message: text('assistant', 'done'), continuation: null, usage: null, finish_reason: 'stop' } },
    } }
    const run = { signal: context.signal, handle: { run: 'r' }, rpc: { call: async () => {} } }
    const request = { id: 'r1', run: 'r', plan: null, header: input().header }
    const plan = await service.prepare(entry, run, request, input())
    assert.equal(plan.profile.id, 'default')
    assert.equal(plan.profile.credentialRef, undefined)
    const first = service.execute(entry, run, { ...request, plan })
    assert.equal(service.execute(entry, run, { ...request, plan }), first)
    assert.throws(() => service.execute(entry, run, { ...request, plan: { ...plan, payload: {} } }), /changed/)
    release(); await first
    assert.equal(sent, 1)
    service.release('r')
    assert.throws(() => service.execute(entry, run, { ...request, plan }), /Stale/)
    assert.throws(() => profiles.assertPublic({ key: 'sentinel-provider-key' }), /credential/)
    assert.throws(() => profiles.assertPublic({ headers: { Authorization: 'anything' } }), /Credentials/)
    assert.equal(profiles.sanitize({ error: 'sentinel-provider-key' }).error, '[redacted]')
    assert.deepEqual(kernelEnvironment({ PATH: '/bin', HOME: '/tmp', OPENAI_API_KEY: 'key', CUSTOM_SECRET: 'secret', NODE_OPTIONS: 'unsafe' }), { PATH: '/bin', HOME: '/tmp' })
  } finally { await env.dispose() }
})

test('Responses tool chain survives restart; wire plans match requests and secrets stay outside Rust', async () => {
  const env = await environment(); let server
  const sentinel = 'test-only-secret-' + crypto.randomUUID()
  const reasoning = { id: 'reason-1', type: 'reasoning', summary: [], encrypted_content: 'opaque-reasoning' }
  const call = { id: 'item-1', type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"sample.txt"}', status: 'completed' }
  const remote = await http(async (body, res, count) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (count === 1) {
      event(res, { type: 'response.output_item.done', output_index: 0, item: reasoning })
      event(res, { type: 'response.completed', response: { status: 'completed', output: [reasoning, call], usage: { input_tokens: 4, output_tokens: 3 } } })
    } else {
      assert.ok(body.input.some(i => i.type === 'function_call_output' && i.call_id === 'call-1'))
      assert.equal(body.input.filter(i => i.id === 'reason-1').length, 1)
      assert.equal(body.input.filter(i => i.call_id === 'call-1' && i.type === 'function_call').length, 1)
      event(res, { type: 'response.output_text.delta', delta: 'Read successfully.' })
      event(res, { type: 'response.completed', response: { status: 'completed', output: [{ id: 'reply-' + count, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Read successfully.' }] }] } })
    }
    res.end()
  })
  try {
    await mkdir(env.home, { recursive: true })
    await writeFile(join(env.home, 'providers.json'), JSON.stringify({ defaultProfile: 'test', profiles: { test: { provider: 'openai-responses', model: 'test-model', endpoint: remote.endpoint + '/responses', credentialRef: 'env:OPENAI_API_KEY' } } }))
    env.environment = { ...process.env, OPENAI_API_KEY: sentinel }
    server = await start(env)
    const state = await run(server, 'responses', 'read sample')
    assert.equal(state.last_outcome, 'completed', server.errors())
    assert.equal(remote.requests.length, 2)
    assert.equal(remote.requests[0].authorization, 'Bearer ' + sentinel)
    const facts = await server.api('/session/responses/facts')
    const requests = facts.filter(record => record.fact.type === 'request_prepared').map(record => record.fact.request)
    for (let index = 0; index < requests.length; index++) assert.deepEqual(requests[index].plan.payload.body, remote.requests[index].body)
    assert.equal(state.nodes[requests[0].id].continuation.data[0].encrypted_content, 'opaque-reasoning')
    assert.ok(!JSON.stringify(facts).includes(sentinel))
    assert.ok(!JSON.stringify(state).includes(sentinel))
    assert.ok(!server.errors().includes(sentinel))
    if (process.platform === 'linux') {
      const children = (await readFile('/proc/' + server.child.pid + '/task/' + server.child.pid + '/children', 'utf8')).trim().split(/\s+/)
      assert.equal(children.length, 1)
      assert.ok(!(await readFile('/proc/' + children[0] + '/environ')).includes(Buffer.from(sentinel)))
    }
    await server.stop(); server = await start(env)
    assert.equal(remote.requests.length, 2)
    assert.equal((await run(server, 'responses', 'continue')).last_outcome, 'completed')
    assert.equal(remote.requests.length, 3)
    assert.deepEqual(remote.errors, [])
  } finally { if (server) await server.stop(); await remote.stop(); await env.dispose() }
})

test('a new protocol runs without a Rust codec; cancellation during prepare never executes', async () => {
  const env = await environment(); let server
  try {
    server = await start(env)
    await define(server, 'custom-provider', { name: 'test.provider', description: '', client: null, dependency_lock: '{}', host: `export default ctx => {
      ctx.morrow.policy('00-provider', async (_run, p, next) => { p.header.provider = 'custom'; await next() });
      ctx.morrow.provider('custom', { capabilities:{text:true,tools:true,streaming:true}, async prepare(input) {
        if (input.messages.at(-1).content === 'slow') await new Promise(resolve => setTimeout(resolve, 300));
        if (input.messages.at(-1).content === 'fail') throw new Error('prepare failed');
        return {format:'custom.commands.v1',payload:{commands:['answer']}};
      }, async execute(plan) { return {message:{role:'assistant',content:plan.payload.commands[0],reasoning:'',tool_calls:[],tool_call_id:null},finish_reason:'stop',usage:null,continuation:null} } });
    }` })
    assert.equal((await run(server, 'custom-provider', 'hello')).last_outcome, 'completed')
    const failed = await run(server, 'custom-provider', 'fail')
    assert.equal(failed.last_outcome, 'failed')
    const failedRequest = (await server.api('/session/custom-provider/facts')).findLast(record => record.fact.type === 'model_requested').fact.request
    assert.equal(failedRequest.plan, null)
    assert.ok(failed.settled_requests.includes(failedRequest.id))
    await server.action('custom-provider', 'submit', { text: 'slow', submission: 'cancel-prepare' })
    const pending = await until(async () => { const s = await server.state('custom-provider'); return Object.values(s.requests).find(r => !s.settled_requests.includes(r.id)) })
    await server.action('custom-provider', 'cancel')
    const cancelled = await until(async () => { const s = await server.state('custom-provider'); return !s.run && s })
    assert.equal(cancelled.requests[pending.id].plan, null)
    assert.equal(cancelled.effects[pending.id], undefined)
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal((await server.state('custom-provider')).effects[pending.id], undefined)
  } finally { if (server) await server.stop(); await env.dispose() }
})

test('v1 history stays readable; copy migration preserves the original and enables v2 execution', async () => {
  const env = await environment(); let server
  try {
    const workspace = toNamespacedPath(await realpath(env.workspace))
    await mkdir(join(env.home, 'sessions'), { recursive: true })
    const fixture = await readFile(new URL('../crates/kernel/src/legacy/fixtures/v1.jsonl', import.meta.url), 'utf8')
    let previous = ''
    const records = fixture.trim().split('\n').map(line => {
      const record = JSON.parse(line)
      if (record.fact.type === 'session_opened') record.fact.workspace = workspace
      record.previous = previous
      record.hash = createHash('sha256').update(JSON.stringify([1, record.seq, previous, record.fact])).digest('hex')
      previous = record.hash; return record
    })
    const original = records.map(r => JSON.stringify(r)).join('\n') + '\n'
    const path = join(env.home, 'sessions/legacy.jsonl')
    await writeFile(path, original)
    server = await start(env)
    const old = await server.state('legacy')
    assert.equal(old.legacy, true)
    assert.equal(old.nodes.q.message.content, 'legacy answer')
    await assert.rejects(server.action('legacy', 'submit', { text: 'continue', submission: 'new' }), /read-only/)
    await server.action('legacy', 'migrate', { target: 'upgraded' })
    assert.equal(await readFile(path, 'utf8'), original)
    const upgraded = await server.state('upgraded')
    assert.equal(upgraded.legacy, false)
    assert.equal(upgraded.nodes.q.message.content, 'legacy answer')
    const facts = await server.api('/session/upgraded/facts')
    assert.equal(facts[1].fact.hash, records.at(-1).hash)
    await assert.rejects(server.action('legacy', 'migrate', { target: 'upgraded' }), /exists/)
    await define(server, 'upgraded', { name: 'test.driver', description: '', client: null, dependency_lock: '{}', host: `export default ctx => ctx.morrow.driver('default',{async run(run){await run.beginStep();await run.append({role:'assistant',content:'v2 continued',reasoning:'',tool_calls:[],tool_call_id:null});await run.endStep()}})` })
    assert.equal((await run(server, 'upgraded', 'continue')).last_outcome, 'completed')
  } finally { if (server) await server.stop(); await env.dispose() }
})

test('workspace v1 migration uses a separate v2 file and hides internal sessions', async () => {
  const env = await environment(); let server
  try {
    const workspace = toNamespacedPath(await realpath(env.workspace))
    await mkdir(join(env.home, 'sessions'), { recursive: true })
    const fixture = await readFile(new URL('../crates/kernel/src/legacy/fixtures/v1.jsonl', import.meta.url), 'utf8')
    let previous = ''
    const records = fixture.trim().split('\n').map(line => {
      const record = JSON.parse(line)
      if (record.fact.type === 'session_opened') record.fact.workspace = workspace
      record.previous = previous
      record.hash = createHash('sha256').update(JSON.stringify([1, record.seq, previous, record.fact])).digest('hex')
      previous = record.hash; return record
    })
    const original = records.map(r => JSON.stringify(r)).join('\n') + '\n'
    const hash = createHash('sha256').update(workspace).digest('hex')
    const path = join(env.home, 'sessions/workspace-' + hash + '.jsonl')
    await writeFile(path, original)
    await cli(env, ['--session', '_workspace', 'session', 'migrate', '_workspace'])
    assert.equal(await readFile(path, 'utf8'), original)
    assert.equal(JSON.parse((await readFile(join(env.home, 'sessions/workspace-v2-' + hash + '.jsonl'), 'utf8')).split('\n')[0]).protocol, 2)
    server = await start(env)
    assert.equal((await server.state('_workspace')).legacy, false)
    assert.ok(!JSON.stringify(await server.api('/sessions')).includes('workspace-'))
  } finally { if (server) await server.stop(); await env.dispose() }
})

test('public CLI reads Node-local credentials and prints complete model output', async () => {
  const env = await environment()
  const remote = await http(async (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    event(res, { choices: [{ delta: { content: 'CLI completed.' }, finish_reason: 'stop' }] }); res.end()
  })
  try {
    const configured = await cli(env, ['credential', 'set', 'test'], 'cli-only-secret\n')
    assert.ok(!configured.includes('cli-only-secret'))
    if (process.platform !== 'win32') assert.equal((await stat(join(env.home, 'credentials.json'))).mode & 0o777, 0o600)
    await writeFile(join(env.home, 'providers.json'), JSON.stringify({ defaultProfile: 'test', profiles: { test: { provider: 'openai-chat', model: 'test', endpoint: remote.endpoint, credentialRef: 'local:test' } } }))
    assert.equal(await cli(env, ['run', 'hello']), 'CLI completed.\n')
    assert.equal(remote.requests[0].authorization, 'Bearer cli-only-secret')
    const workspaceHash = createHash('sha256').update(toNamespacedPath(await realpath(env.workspace))).digest('hex')
    assert.ok(!(await readFile(join(env.home, 'sessions', workspaceHash, 'default.jsonl'), 'utf8')).includes('cli-only-secret'))
  } finally { await remote.stop(); await env.dispose() }
})

test('supplier lists start empty, preserve saved custom suppliers and do not resurrect removed profiles', async () => {
  const env = await environment()
  try {
    const profiles = new Profiles(env.home, {}); await profiles.load()
    assert.deepEqual(await profiles.list(), [])
    assert.equal(profiles.defaultId, '')
    const ark = { id: 'ark', name: 'ARK', provider: 'openai-responses', baseUrl: 'https://example.com/api/coding/v3', model: 'configured-model', options: {}, apiKey: 'ark-configured-key' }
    await profiles.save({ ...ark, id: 'default' })
    await profiles.save({ ...ark, makeDefault: true })
    await profiles.remove('default')
    const reopened = new Profiles(env.home, { OPENAI_API_KEY: 'environment-key' }); await reopened.load()
    assert.deepEqual((await reopened.list()).map(profile => profile.id), ['ark'])
    assert.equal(reopened.defaultId, 'ark')
    assert.equal(reopened.get('ark').model, ark.model)
    assert.equal(await reopened.reveal('ark'), ark.apiKey)
    await reopened.remove('ark')
    const empty = new Profiles(env.home, {}); await empty.load()
    assert.deepEqual(await empty.list(), [])
    assert.equal(empty.defaultId, '')
  } finally { await env.dispose() }
})

test('explicit environment configuration creates only its Chat supplier', async () => {
  const env = await environment()
  try {
    const profiles = new Profiles(env.home, { OPENAI_API_KEY: 'environment-key', OPENAI_BASE_URL: 'https://example.com/v1', OPENAI_MODEL: 'my-model' }); await profiles.load()
    assert.deepEqual((await profiles.list()).map(profile => profile.id), ['default'])
    assert.equal(profiles.get('default').model, 'my-model')
    assert.equal(await profiles.reveal('default'), 'environment-key')
  } finally { await env.dispose() }
})

test('configuration service persists concurrent edits, preserves credentials, and pins prepared requests', async () => {
  const env = await environment()
  try {
    const profiles = new Profiles(env.home, {}); await profiles.load()
    const config = { id: 'work', provider: 'openai-chat', model: 'before', endpoint: 'http://localhost:10001/chat', options: {}, apiKey: 'settings-first-secret' }
    await Promise.all([profiles.save(config), profiles.save({ ...config, id: 'second', apiKey: 'settings-second-secret' })])
    const loaded = new Profiles(env.home, {}); await loaded.load()
    assert.equal((await loaded.list()).filter(profile => profile.configured).length, 2)
    const old = profiles.get('work')
    const inputValue = { ...input(), header: { ...input().header, profile: 'work', model: 'before' } }
    const request = { id: 'pin-config', run: 'r', plan: null, header: inputValue.header }
    const service = new ProviderService(profiles)
    const entry = { registration: { kind: 'model', name: 'openai-chat' }, signal: context.signal, provider: {
      capabilities: { text: true, tools: true, streaming: false },
      prepare: async (_input, selected) => ({ format: 'test', payload: { endpoint: selected.endpoint } }),
      execute: async (plan, execution) => {
        assert.equal(plan.payload.endpoint, config.endpoint)
        assert.equal(await execution.credential(), config.apiKey)
        return { message: text('assistant', 'done'), continuation: null, usage: null, finish_reason: 'stop' }
      },
    } }
    const run = { signal: context.signal, handle: {}, rpc: { call: async () => {} } }
    const plan = await service.prepare(entry, run, request, inputValue)
    await profiles.save({ ...config, endpoint: 'http://localhost:10002/chat', model: 'after', apiKey: 'settings-rotated-secret', makeDefault: true })
    await service.execute(entry, run, { ...request, plan })
    await profiles.save({ ...config, apiKey: '', model: 'retained', makeDefault: true })
    assert.equal(await profiles.credential(profiles.get('work')), 'settings-rotated-secret')
    assert.equal(await profiles.credential(old), config.apiKey)
    assert.ok(!JSON.stringify(await profiles.list()).includes('secret'))
    assert.ok(!(await readFile(join(env.home, 'providers.json'), 'utf8')).includes('secret'))
    await profiles.remove('second')
    const reopened = new Profiles(env.home, {}); await reopened.load()
    assert.equal(reopened.defaultId, 'work')
    assert.equal(reopened.public('work').model, 'retained')
    assert.ok(!(await reopened.list()).some(profile => profile.id === 'second'))
    await assert.rejects(profiles.save({ ...config, options: { api_key: 'bad' } }), /Credentials/)
    await assert.rejects(profiles.save({ ...config, id: undefined }), /供应商 ID/)
    await assert.rejects(profiles.save({ ...config, makeDefault: 'false' }), /默认连接/)
    assert.equal(profiles.public('work').model, 'retained')
  } finally { await env.dispose() }
})

test('built-in configuration plugin works before a run, updates live requests and keeps keys out of facts', async () => {
  const env = await environment(); let server
  const remote = await http(async (body, res) => { event(res, { choices: [{ delta: { content: body.model }, finish_reason: 'stop' }] }); res.end() })
  try {
    server = await start(env)
    const invoke = (method, input) => server.action('default', 'invoke', { plugin: 'morrow.settings', hash: '1', method, input })
    const initial = await invoke('profiles.get')
    assert.ok(initial.providers.includes('openai-responses'))
    assert.equal((await server.state('default')).run, null)
    await assert.rejects(invoke('settings.get'), /host RPC failed/)
    await assert.rejects(invoke('settings.set', { model: 'obsolete' }), /host RPC failed/)
    // Simulate a session saved by the removed settings feature, without rewriting its fact log.
    const legacy = { profile: 'removed-profile', model: 'obsolete-model', provider: 'openai-responses', system: 'obsolete-system', parameters: { temperature: 0.9 } }
    const legacyHash = await define(server, 'default', { name: 'morrow.settings', description: 'Legacy state fixture', client: null, dependency_lock: '{}', host: `export default ctx => ctx.morrow.method('seed-legacy', (input, run) => run.setState('model', input))` })
    await server.action('default', 'resume')
    await server.action('default', 'invoke', { plugin: 'morrow.settings', hash: legacyHash, method: 'seed-legacy', input: legacy })
    await server.action('default', 'stop', { hash: legacyHash })
    await server.action('default', 'resume')
    const config = { id: 'web', provider: 'openai-chat', model: 'from-web', endpoint: remote.endpoint, options: { temperature: 0.25 }, apiKey: 'web-only-secret', makeDefault: true }
    await invoke('profiles.save', config)
    assert.equal((await run(server, 'default', 'hello')).last_outcome, 'completed')
    assert.equal(remote.requests[0].body.model, 'from-web')
    assert.equal(remote.requests[0].body.temperature, 0.25)
    assert.ok(!JSON.stringify(remote.requests[0].body).includes('obsolete'))
    assert.deepEqual((await server.state('default')).plugin_state['morrow.settings'].model, legacy)
    assert.equal(remote.requests[0].authorization, 'Bearer web-only-secret')
    await invoke('profiles.save', { ...config, model: 'updated-live', apiKey: '' })
    assert.equal((await run(server, 'default', 'continue')).last_outcome, 'completed')
    assert.equal(remote.requests[1].body.model, 'updated-live')
    assert.ok(!JSON.stringify(await server.api('/session/default/facts')).includes('web-only-secret'))
    assert.ok(!JSON.stringify(await invoke('profiles.get')).includes('web-only-secret'))
    await define(server, 'default', { name: 'test.config-service', description: '', client: null, dependency_lock: '{}', host: `export default {inject:['modelProfiles'],apply(ctx){ctx.morrow.method('connections',()=>ctx.modelProfiles.list())}}` })
    await server.action('default', 'resume')
    const state = await server.state('default')
    const result = await server.action('default', 'invoke', { plugin: 'test.config-service', hash: state.bindings['test.config-service'].hash, method: 'connections', input: {} })
    assert.ok(result.some(profile => profile.id === 'web'))
    await invoke('profiles.save', { ...config, id: 'web-next', model: 'switched-default' })
    assert.equal((await run(server, 'default', 'switch connection')).last_outcome, 'completed')
    assert.equal(remote.requests[2].body.model, 'switched-default')
    assert.equal((await run(server, 'new-session', 'same default')).last_outcome, 'completed')
    assert.equal(remote.requests[3].body.model, 'switched-default')
    await server.stop(); server = await start(env)
    assert.equal((await invoke('profiles.get')).defaultId, 'web-next')
    assert.equal((await run(server, 'default', 'restart')).last_outcome, 'completed')
    assert.equal(remote.requests[4].body.model, 'switched-default')
    assert.equal(remote.requests[4].authorization, 'Bearer web-only-secret')
  } finally { if (server) await server.stop(); await remote.stop(); await env.dispose() }
})

test('supplier models, per-session selection, probing, credential reveal and disabling work through the plugin', async () => {
  const env = await environment(); let server
  const remote = await http(async (body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (body.input) event(res, { type: 'response.completed', response: { status: 'completed', output: [{ id: crypto.randomUUID(), type: 'message', role: 'assistant', content: [{ type: 'output_text', text: body.model }] }] } })
    else event(res, { choices: [{ delta: { content: body.model }, finish_reason: 'stop' }] })
    res.end()
  })
  try {
    server = await start(env)
    const invoke = (method, input, session = 'default') => server.action(session, 'invoke', { plugin: 'morrow.settings', hash: '1', method, input })
    const models = [{ id: 'fast', name: '快速模型', contextWindow: 1_000_000, vision: true }, { id: 'smart', name: '推理模型', contextWindow: 128_000, vision: false }]
    const config = { id: 'ark', name: 'ARK', provider: 'openai-chat', baseUrl: remote.endpoint + '/api/coding/v3/', enabled: true, models, options: {}, apiKey: 'supplier-test-key', makeDefault: true }
    assert.deepEqual(await invoke('profiles.save', config), { saved: true })
    const info = await invoke('profiles.get')
    assert.equal(info.defaultId, 'ark')
    assert.equal(info.profiles.find(p => p.id === 'ark').baseUrl, remote.endpoint + '/api/coding/v3')
    assert.deepEqual(info.profiles.find(p => p.id === 'ark').models, models)
    assert.equal(info.formats.find(f => f.id === 'openai-responses').requestPath, '/responses')
    assert.ok(!JSON.stringify(info).includes('supplier-test-key'))
    assert.deepEqual(await invoke('profiles.reveal', { id: 'ark' }), { apiKey: 'supplier-test-key' })
    const before = (await server.state('default')).seq
    assert.ok((await invoke('models.test', { id: 'ark', model: 'smart' })).latencyMs >= 0)
    assert.equal((await server.state('default')).seq, before)
    assert.equal(remote.requests[0].path, '/api/coding/v3/chat/completions')
    assert.equal(remote.requests[0].body.model, 'smart')
    assert.deepEqual(await invoke('models.select', { profile: 'ark', model: 'smart' }), { selected: true })
    assert.equal((await run(server, 'default', 'use my selection')).last_outcome, 'completed')
    assert.equal(remote.requests[1].body.model, 'smart')
    assert.equal((await run(server, 'another-session', 'use the default')).last_outcome, 'completed')
    assert.equal(remote.requests[2].body.model, 'fast')
    await invoke('profiles.save', { ...config, provider: 'openai-responses', apiKey: '', name: 'ARK Responses' })
    assert.equal((await run(server, 'response-session', 'use responses')).last_outcome, 'completed')
    assert.equal(remote.requests[3].path, '/api/coding/v3/responses')
    assert.equal(remote.requests[3].authorization, 'Bearer supplier-test-key')
    const duplicate = await invoke('profiles.save', { ...config, models: [models[0], models[0]], apiKey: '' })
    assert.match(duplicate.error, /不能重复/)
    await server.stop(); server = await start(env)
    assert.equal((await invoke('profiles.get')).selection.model, 'smart')
    assert.equal((await invoke('profiles.get')).profiles.find(p => p.id === 'ark').name, 'ARK Responses')
    await invoke('profiles.save', { ...config, enabled: false, makeDefault: false, apiKey: '' })
    assert.match((await invoke('models.select', { profile: 'ark', model: 'fast' })).error, /禁用/)
    const count = remote.requests.length
    assert.equal((await run(server, 'default', 'disabled supplier')).last_outcome, 'failed')
    assert.equal(remote.requests.length, count)
    assert.ok(!JSON.stringify(await server.api('/session/default/facts')).includes('supplier-test-key'))
    await invoke('profiles.remove', { id: 'ark' })
    assert.ok(!(await invoke('profiles.get')).profiles.some(p => p.id === 'ark'))
    assert.deepEqual(await invoke('models.select', null), { selected: true })
    assert.equal((await invoke('profiles.get')).selection, null)
  } finally { if (server) await server.stop(); await remote.stop(); await env.dispose() }
})

test('legacy Base URL profiles can switch models and recover after an HTTP failure', async () => {
  const env = await environment(); let server
  const remote = await http(async (body, res) => {
    if (body.model === 'missing-model') { res.writeHead(404); res.end('private remote detail'); return }
    event(res, { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: body.model }] }] } })
    res.end()
  })
  try {
    await mkdir(env.home, { recursive: true })
    await writeFile(join(env.home, 'credentials.json'), JSON.stringify({ test: 'legacy-recovery-key' }))
    await writeFile(join(env.home, 'providers.json'), JSON.stringify({ defaultProfile: 'ark', profiles: { ark: {
      provider: 'openai-responses', endpoint: remote.endpoint + '/api/coding/v3', model: 'missing-model', credentialRef: 'local:test', options: {},
      models: ['missing-model', 'working-model'].map(id => ({ id, name: id, contextWindow: 1000000, vision: false })),
    } } }))
    server = await start(env)
    assert.equal((await run(server, 'recovery', 'hi')).last_outcome, 'failed')
    const facts = await server.api('/session/recovery/facts')
    const error = facts.findLast(record => record.fact.type === 'model_settled').fact.error
    assert.match(error.message, /HTTP 404.*Base URL/)
    assert.equal(error.details.status, 404)
    assert.deepEqual(await server.action('recovery', 'invoke', { plugin: 'morrow.settings', hash: '1', method: 'models.select', input: { profile: 'ark', model: 'working-model' } }), { selected: true })
    assert.equal((await run(server, 'recovery', 'retry')).last_outcome, 'completed')
    assert.deepEqual(remote.requests.map(request => ({ path: request.path, model: request.body.model })), [
      { path: '/api/coding/v3/responses', model: 'missing-model' }, { path: '/api/coding/v3/responses', model: 'working-model' },
    ])
    assert.ok(!JSON.stringify(await server.api('/session/recovery/facts')).includes('legacy-recovery-key'))
  } finally { if (server) await server.stop(); await remote.stop(); await env.dispose() }
})
