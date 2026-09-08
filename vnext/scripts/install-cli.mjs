import { spawnSync } from 'node:child_process'
import { mkdir, open, lstat, rename, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const marker = 'morrow-vnext managed launcher'
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const windows = process.platform === 'win32'

async function managed(path) {
  try {
    const file = await open(path, 'r')
    try { const buffer = Buffer.alloc(512); const { bytesRead } = await file.read(buffer); return buffer.subarray(0, bytesRead).includes(Buffer.from(marker)) }
    finally { await file.close() }
  } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

async function main() {
  const args = process.argv.slice(2)
  let directory = join(homedir(), '.local', 'bin'), build = true
  while (args.length) {
    const flag = args.shift()
    if (flag === '--bin-dir' && args.length) directory = resolve(args.shift())
    else if (flag === '--no-build') build = false
    else throw new Error('Usage: node scripts/install-cli.mjs [--bin-dir DIR] [--no-build]')
  }
  if (build) {
    for (const [command, options] of [['cargo', ['build', '--bin', 'morrow-kernel']], [windows ? 'pnpm.cmd' : 'pnpm', ['build']]]) {
      const result = spawnSync(command, options, { cwd: root, stdio: 'inherit', shell: windows })
      if (result.error || result.status !== 0) throw new Error(`Build failed: ${command} ${options.join(' ')}`)
    }
  }
  const launcher = join(root, 'packages/host/dist/launcher.js')
  if (!existsSync(launcher) || !existsSync(join(root, 'target/debug/morrow-kernel' + (windows ? '.exe' : '')))) throw new Error('Build the application first, or run pnpm cli:install without --no-build')
  const path = join(directory, windows ? 'morrow.cmd' : 'morrow')
  const body = windows
    ? `@echo off\r\n@rem ${marker}\r\n"${process.execPath.replaceAll('%', '%%')}" "${launcher.replaceAll('%', '%%')}" %*\r\n`
    : `#!/bin/sh\n# ${marker}\nexec ${quote(process.execPath)} ${quote(launcher)} "$@"\n`
  await mkdir(directory, { recursive: true })
  const temporary = path + '.' + crypto.randomUUID() + '.tmp'
  await writeFile(temporary, body, { mode: 0o755, flag: 'wx' })
  const backups = []
  try {
    for (const old of windows ? [path, join(directory, 'morrow.exe')] : [path]) {
      const present = await lstat(old).catch(error => { if (error.code !== 'ENOENT') throw error })
      if (!present || await managed(old)) continue
      const suffix = old.endsWith('.exe') ? '.exe' : windows ? '.cmd' : ''
      let backup = join(directory, 'morrow-legacy' + suffix)
      const occupied = await lstat(backup).catch(error => { if (error.code !== 'ENOENT') throw error })
      if (occupied) backup = join(directory, `morrow-legacy-${crypto.randomUUID()}${suffix}`)
      await rename(old, backup)
      backups.push([old, backup])
    }
    await rename(temporary, path)
  } catch (error) {
    for (const [old, backup] of backups.reverse()) await rename(backup, old)
    throw error
  } finally { await rm(temporary, { force: true }) }
  for (const [, backup] of backups) console.log('原有命令已保留：' + backup)
  console.log('已安装：' + path + '\n在项目目录运行 morrow server（或直接 morrow）。')
  const paths = (process.env.PATH ?? '').split(delimiter).map(entry => resolve(entry))
  if (!paths.includes(resolve(directory))) console.log('请将此目录加入 PATH：' + directory)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
