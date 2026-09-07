import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

const [name, host, client, lock] = process.argv.slice(2)
if (!name || !host || !lock) throw new Error('Usage: node scripts/plugin.mjs name host.ts client.ts|- dependency-lock-file')
const bundle = async (entry, platform) => (await build({ entryPoints: [entry], bundle: true, write: false, platform, format: 'esm', target: 'es2023', sourcemap: 'inline', external: ['@morrow/sdk', '@deepseek-ai/cordis', 'react'] })).outputFiles[0].text
console.log(JSON.stringify({ name, description: name, host: await bundle(host, 'node'), client: client === '-' ? null : await bundle(client, 'browser'), dependency_lock: await readFile(lock, 'utf8') }, null, 2))
