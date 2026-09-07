import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { build as vite } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

process.chdir(fileURLToPath(new URL('..', import.meta.url)))
for (const name of ['cosmokit', 'cordis']) {
  execFileSync('pnpm', ['exec', 'tsc', '-p', `vendor/${name}/tsconfig.json`], { stdio: 'inherit' })
  await build({ entryPoints: [`vendor/${name}/src/index.ts`], outfile: `vendor/${name}/lib/index.js`, bundle: true, format: 'esm', target: 'es2023', packages: 'external' })
}
await build({ entryPoints: ['packages/sdk/src/index.ts'], outfile: 'packages/sdk/dist/index.js', bundle: true, format: 'esm', platform: 'node', packages: 'external', sourcemap: true })
await build({ entryPoints: ['packages/host/src/index.ts'], outfile: 'packages/host/dist/index.js', bundle: true, format: 'esm', platform: 'node', packages: 'external', sourcemap: true })
await vite({ root: resolve('packages/web'), plugins: [tailwindcss()], build: { outDir: 'dist', rollupOptions: { preserveEntrySignatures: 'strict', input: { main: resolve('packages/web/index.html'), react: resolve('packages/web/src/react.ts'), cordis: resolve('packages/web/src/cordis.ts') }, output: { entryFileNames: '[name].js' } } } })
