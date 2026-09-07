import { build } from 'esbuild'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const output = resolve(process.argv[2] ?? 'dist/morrow-next')
const suffix = process.platform === 'win32' ? '.exe' : ''
await mkdir(join(output, 'packages/host/dist'), { recursive: true })
await cp(`target/release/morrow-next${suffix}`, join(output, `morrow-next${suffix}`))
await cp(process.execPath, join(output, `node${suffix}`))
await cp('packages/web/dist', join(output, 'packages/web/dist'), { recursive: true })
const destination = join(output, 'packages/host/dist')
const shared = (mapping) => ({ name: 'shared-runtime', setup(build) {
  build.onResolve({ filter: /^(@morrow\/sdk|@deepseek-ai\/cordis)$/ }, args => mapping[args.path] ? { path: mapping[args.path], external: true } : undefined)
} })
await build({ entryPoints: ['vendor/cordis/src/index.ts'], outfile: join(destination, 'cordis.js'), bundle: true, platform: 'node', format: 'esm', target: 'node24' })
await build({ entryPoints: ['packages/sdk/src/index.ts'], outfile: join(destination, 'sdk.js'), bundle: true, platform: 'node', format: 'esm', target: 'node24', plugins: [shared({ '@deepseek-ai/cordis': './cordis.js' })] })
await build({ entryPoints: ['packages/host/src/index.ts'], outfile: join(destination, 'index.js'), bundle: true, platform: 'node', format: 'esm', target: 'node24', define: { 'process.env.MORROW_BUNDLED': '"1"' }, plugins: [shared({ '@deepseek-ai/cordis': './cordis.js', '@morrow/sdk': './sdk.js' })], banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } })
await writeFile(join(output, 'package.json'), '{"type":"module"}\n')
await cp('vendor/cordis/LICENSE', join(output, 'CORDIS-LICENSE'))
await cp('vendor/cosmokit/LICENSE', join(output, 'COSMOKIT-LICENSE'))
await cp('README.md', join(output, 'README.md'))
console.log(output)
