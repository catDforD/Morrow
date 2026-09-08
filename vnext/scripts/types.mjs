import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
const output = execFileSync('cargo', ['run', '--quiet', '--bin', 'export-types'], { encoding: 'utf8' })
const file = 'packages/sdk/src/protocol.ts'
if (process.argv.includes('--check')) {
  if (readFileSync(file, 'utf8') !== output) throw new Error('Protocol types are stale; run pnpm types')
} else writeFileSync(file, output)
