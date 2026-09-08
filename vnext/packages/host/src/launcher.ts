import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import WebSocket from 'ws'
import { Profiles } from './provider-service.js'
import { startHost } from './index.js'

export function kernelEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM']) if (source[key]) result[key] = source[key]
  return result
}

async function main() {
  const args = process.argv.slice(2)
  const flags: Record<string, string> = {}
  let approve = false
  let selected: string | undefined
  while (args.length) {
    if (!args[0].startsWith('--')) {
      if (selected) throw new Error('Unexpected server argument')
      selected = args.shift()
      if (!['server', 'serve'].includes(selected!)) break
      continue
    }
    const flag = args.shift()!
    if (flag === '--help') { console.log('morrow [server] [--port PORT] [--workspace DIR] [--home DIR]\n\n默认启动 Web 服务：http://127.0.0.1:3001；当前目录作为工作区。\nProvider、API key 和模型可在网页的“模型设置”中配置。\n\n其他命令：run PROMPT | history | session migrate TARGET | plugin ... | credential set NAME\n全局选项：--session NAME --profile ID --model MODEL --base-url URL --approve-all\n兼容命令：serve'); return }
    if (flag === '--approve-all') { approve = true; continue }
    if (!['--home', '--workspace', '--session', '--resources', '--kernel', '--model', '--base-url', '--profile', '--port'].includes(flag) || !args.length || args[0].startsWith('--')) throw new Error('Unknown or incomplete option: ' + flag)
    flags[flag] = args.shift()!
  }
  const command = !selected || selected === 'server' ? 'serve' : selected
  const home = resolve(flags['--home'] ?? process.env.MORROW_NEXT_HOME ?? join(homedir(), '.morrow-vnext'))
  const workspace = resolve(flags['--workspace'] ?? '.')
  const session = flags['--session'] ?? 'default'
  const resources = resolve(flags['--resources'] ?? process.env.MORROW_NEXT_RESOURCES ?? join(import.meta.dirname, '../../..'))
  await mkdir(home, { recursive: true })
  if (command === 'credential') {
    if (args[0] !== 'set' || !args[1] || !/^[a-zA-Z0-9_-]+$/.test(args[1]) || args.length !== 2) throw new Error('Usage: credential set NAME < key-file')
    if (process.stdin.isTTY) throw new Error('Provide the key through stdin: credential set NAME < key-file')
    const chunks: Buffer[] = []; let length = 0
    for await (const chunk of process.stdin) { length += chunk.length; if (length > 65_536) throw new Error('Credential too large'); chunks.push(chunk) }
    const key = Buffer.concat(chunks).toString('utf8').trim()
    if (!key) throw new Error('Empty credential')
    const path = join(home, 'credentials.json')
    let values: Record<string, string> = {}
    try { values = JSON.parse(await readFile(path, 'utf8')) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    values[args[1]] = key
    const temp = path + '.' + crypto.randomUUID() + '.tmp'
    await writeFile(temp, JSON.stringify(values), { mode: 0o600, flag: 'wx' }); await rename(temp, path)
    console.log('Credential configured: local:' + args[1]); return
  }
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const bundled = join(resources, 'morrow-kernel' + suffix)
  const kernel = flags['--kernel'] ?? (existsSync(bundled) ? bundled : join(resources, 'target/debug/morrow-kernel' + suffix))
  const common = ['--home', home, '--workspace', workspace, '--session', session, '--resources', resources, ...(approve ? ['--approve-all'] : [])]
  if (['history', 'plugin', 'session'].includes(command)) {
    if (command === 'session' && (args[0] !== 'migrate' || args.length !== 2)) throw new Error('Usage: session migrate TARGET')
    const tail = command === 'session' ? ['migrate', args[1]] : [command, ...args]
    const child = spawn(kernel, [...common, ...tail], { env: kernelEnvironment(process.env), stdio: 'inherit' })
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => { process.exitCode = code ?? 1; resolve() }) }); return
  }
  if (!['run', 'serve'].includes(command)) throw new Error('Unknown command: ' + command)
  if (flags['--port'] && (!/^\d+$/.test(flags['--port']) || Number(flags['--port']) > 65535)) throw new Error('Port must be between 0 and 65535')
  const profiles = new Profiles(home)
  await profiles.load({ model: flags['--model'], baseUrl: flags['--base-url'], profile: flags['--profile'] })
  const child = spawn(kernel, [...common, 'serve', '--port', command === 'serve' ? flags['--port'] ?? '3001' : '0'], { env: kernelEnvironment(process.env), stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
  child.stderr.on('data', data => process.stderr.write(profiles.sanitize(data.toString())))
  let host: Awaited<ReturnType<typeof startHost>> | undefined
  const stop = () => child.stdin.end()
  const terminate = () => stop()
  process.on('SIGTERM', terminate)
  try {
    const ready = await new Promise<any>((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('Kernel startup timed out')) }, 20_000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Kernel exited: ' + code)) })
      child.stdout.on('data', bytes => {
        buffer += bytes.toString()
        let end: number
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          try { const value = JSON.parse(line); if (value.kernel_listening) { clearTimeout(timer); resolve(value) } }
          catch { process.stderr.write('Invalid kernel bootstrap message\n') }
        }
      })
    })
    host = await startHost(ready.url, ready.host_token, home, profiles)
    if (command === 'serve') {
      process.on('SIGINT', terminate)
      console.error('Morrow vNext: ' + ready.url + '/#token=' + ready.token)
      console.log(JSON.stringify({ ready: true, url: ready.url, token: ready.token }))
      process.exitCode = (await exited) ?? 1
    } else {
      await runCli(ready, session, args)
    }
  } finally {
    stop()
    host?.host.cancelAll()
    const timer = setTimeout(() => child.kill('SIGKILL'), 9_000)
    await exited; clearTimeout(timer)
    await host?.host.dispose(); host?.socket.close()
    process.off('SIGINT', terminate); process.off('SIGTERM', terminate)
  }
}

async function runCli(ready: any, session: string, args: string[]) {
  const prompt = args.shift()
  if (!prompt) throw new Error('run requires a prompt')
  const submission = args[0] === '--submission' && args[1] ? args[1] : crypto.randomUUID()
  const api = async (body?: object) => {
    const response = await fetch(ready.url + '/api/session/' + encodeURIComponent(session), { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + ready.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const value = await response.json() as any
    if (!response.ok) throw new Error(value.error)
    return value
  }
  const socket = new WebSocket(ready.url.replace(/^http/, 'ws') + '/events?token=' + ready.token)
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  let activeRun = '', activeRequest = '', sequence = 0
  const streamed = new Map<string, string>()
  socket.on('message', bytes => {
    const event = JSON.parse(bytes.toString())
    if (event.session !== session) return
    const fact = event.record?.fact
    if (fact?.type === 'run_started' && fact.submission === submission) activeRun = fact.run
    if (fact?.type === 'request_prepared' && fact.request.run === activeRun && fact.request.purpose === 'main') { activeRequest = fact.request.id; sequence = 0 }
    if (event.type !== 'model_progress' || event.run !== activeRun || event.request !== activeRequest || event.sequence <= sequence || event.purpose !== 'main') return
    sequence = event.sequence
    for (const delta of event.events) if (delta.type === 'text') { process.stdout.write(delta.text); streamed.set(activeRequest, (streamed.get(activeRequest) ?? '') + delta.text) }
  })
  const cancel = () => { void api({ action: 'cancel' }).catch(() => {}) }
  process.on('SIGINT', cancel)
  try {
    await api({ action: 'submit', text: prompt, submission })
    const answered = new Set<string>()
    while (true) {
      const state = (await api()).session
      for (const [id, approval] of Object.entries(state.approvals) as [string, any][]) {
        if (approval.approved !== null || answered.has(id)) continue
        answered.add(id)
        let approved = false
        if (process.stdin.isTTY) {
          const ui = createInterface({ input: process.stdin, output: process.stderr })
          try { approved = (await ui.question('Approve ' + approval.name + ' ' + JSON.stringify(approval.input) + '? [y/N] ')).trim().toLowerCase() === 'y' } finally { ui.close() }
        }
        await api({ action: 'approve', id, approved })
      }
      if (state.claimed.includes(submission) && !state.run && state.last_outcome) {
        if (state.last_outcome !== 'completed') throw new Error('Run ended: ' + state.last_outcome)
        const id = state.surface.at(-1), content = state.nodes[id]?.message.content ?? '', shown = streamed.get(id) ?? ''
        process.stdout.write(content.startsWith(shown) ? content.slice(shown.length) : '\n' + content)
        process.stdout.write('\n'); return
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  } finally { process.off('SIGINT', cancel); socket.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main().catch(() => { console.error('Morrow startup or execution failed. Check the selected profile, credentials and kernel build.'); process.exitCode = 1 })
