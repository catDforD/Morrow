import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

export const root = resolve(import.meta.dirname, '..')
export async function environment() {
  const directory = await mkdtemp(join(tmpdir(), 'morrow-next-test-'))
  const home = join(directory, 'home'), workspace = join(directory, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'sample.txt'), 'hello fact kernel\n')
  return { directory, home, workspace, async dispose() { await rm(directory, { recursive: true, force: true }) } }
}
export async function start(env) {
  const launcher = env.launcher ?? resolve(root, 'packages/host/dist/launcher.js')
  const command = env.command ?? [env.node ?? process.execPath, launcher, '--home', env.home, '--workspace', env.workspace, ...(env.launcher ? [] : ['--resources', root]), 'serve', '--port', '0']
  const child = spawn(command[0], command.slice(1), { cwd: env.workspace, env: env.environment ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let errors = '', output = ''
  child.stderr.on('data', data => { errors += data.toString() })
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`startup timed out: ${errors}`)) }, 25000)
    child.on('error', reject)
    child.on('exit', code => { clearTimeout(timeout); reject(new Error(`server exited ${code}: ${errors}`)) })
    child.stdout.on('data', data => {
      output += data
      for (const line of output.split('\n')) {
        try { const value = JSON.parse(line); if (value.ready) { clearTimeout(timeout); resolve(value); return } } catch {}
      }
    })
  })
  const api = async (path, body) => {
    const response = await fetch(`${ready.url}/api${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${ready.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const value = await response.json()
    if (!response.ok) throw new Error(value.error)
    return value
  }
  return { ...ready, child, api, errors: () => errors,
    action: (session, action, values = {}) => api(`/session/${session}`, { action, ...values }),
    state: async session => (await api(`/session/${session}`)).session,
    async stop() { if (child.exitCode !== null) return; child.kill('SIGINT'); await new Promise(resolve => child.once('exit', resolve)) },
  }
}
export async function until(predicate, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)) }
  throw new Error('condition timed out')
}
export async function define(server, session, manifest, activate = true) {
  const { hash } = await server.action(session, 'define', { manifest })
  await server.action(session, 'trust', { hash })
  if (activate) await server.action(session, 'activate', { hash })
  return hash
}
export async function run(server, session, text, submission = crypto.randomUUID()) {
  const before = (await server.state(session)).seq
  await server.action(session, 'submit', { text, submission })
  return until(async () => { const state = await server.state(session); return state.seq > before && state.claimed.includes(submission) && state.run === null && state.last_outcome !== null && state }, 15000)
}
