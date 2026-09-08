import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, toNamespacedPath } from 'node:path'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { environment, start, root } from './helpers.mjs'

const execute = promisify(execFile)
const launcher = join(root, 'packages/host/dist/launcher.js')

test('server, serve and the default command accept trailing options and use the current workspace', async () => {
  for (const command of [['server'], ['serve'], []]) {
    const env = await environment(); let server
    try {
      env.command = [process.execPath, launcher, ...command, '--home', env.home, '--port', '0']
      server = await start(env)
      assert.equal((await server.state('default')).workspace, toNamespacedPath(await realpath(env.workspace)))
      assert.equal((await fetch(server.url)).status, 200)
      const profiles = await server.action('default', 'invoke', { plugin: 'morrow.settings', hash: '1', method: 'profiles.get' })
      assert.ok(profiles.providers.includes('openai-chat'))
    } finally { if (server) await server.stop(); await env.dispose() }
  }
})

test('server help works without a configured model or writable home', async () => {
  const { stdout } = await execute(process.execPath, [launcher, 'server', '--help'])
  assert.match(stdout, /morrow \[server\]/)
  assert.match(stdout, /3001/)
})

test('CLI installation preserves an existing command and the installed wrapper starts the server', { skip: process.platform === 'win32' }, async () => {
  const env = await environment(); let server
  try {
    const directory = join(env.directory, "bin with spaces ' quotes")
    await mkdir(directory)
    await writeFile(join(directory, 'morrow'), '#!/bin/sh\n# original morrow\n', { mode: 0o755 })
    const args = [join(root, 'scripts/install-cli.mjs'), '--no-build', '--bin-dir', directory]
    await execute(process.execPath, args)
    assert.equal(await readFile(join(directory, 'morrow-legacy'), 'utf8'), '#!/bin/sh\n# original morrow\n')
    await execute(process.execPath, args)
    assert.equal((await readdir(directory)).filter(name => name.startsWith('morrow-legacy')).length, 1)
    env.command = [join(directory, 'morrow'), 'server', '--home', env.home, '--port', '0']
    server = await start(env)
    assert.equal((await server.state('default')).workspace, toNamespacedPath(await realpath(env.workspace)))
  } finally { if (server) await server.stop(); await env.dispose() }
})
