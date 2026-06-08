// Bundle a single self-contained JS file for the embedded Hermes runtime (no module
// system, no Bun/node runtime). React + react-reconciler are bundled IN so the
// bytecode is self-contained. Optionally compiles to Hermes bytecode.
//
//   bun scripts/bundle-hermes.mjs [entry] [out.js] [--bytecode]
//
// Bun is used only as the dev bundler here; the output runs under Hermes.
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..') // ts/
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const wantBytecode = process.argv.includes('--bytecode')
const entry = args[0] ? resolve(args[0]) : resolve(root, 'examples/hermes-smoke.tsx')
const outJs = args[1] ? resolve(args[1]) : '/tmp/hermes-bundle.js'
const mode = process.env.NODE_ENV || 'development'

const result = await Bun.build({
  entrypoints: [entry],
  target: 'browser', // neutral: no node/bun builtins, self-contained
  format: 'iife', // Hermes runs a script, not a module — no require()
  conditions: ['react-native'],
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode),
    __DEV__: mode === 'development' ? 'true' : 'false',
  },
  sourcemap: 'none',
  throw: false,
})

if (!result.success) {
  console.error('[bundle-hermes] build failed:')
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const code = await result.outputs.find((o) => o.kind === 'entry-point').text()
await Bun.write(outJs, code)
console.log(`[bundle-hermes] ${entry}`)
console.log(`[bundle-hermes] wrote ${outJs} (${(code.length / 1024).toFixed(0)} KB, NODE_ENV=${mode})`)

if (wantBytecode) {
  const hermesc = process.env.HERMESC || '/Users/n8/github/hermes/build/bin/hermesc'
  const outHbc = outJs.replace(/\.js$/, '.hbc')
  const r = spawnSync(hermesc, ['-emit-binary', '-O', '-out', outHbc, outJs], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error('[bundle-hermes] hermesc failed')
    process.exit(1)
  }
  console.log(`[bundle-hermes] wrote ${outHbc} (Hermes bytecode)`)
}
