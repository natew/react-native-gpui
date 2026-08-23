// Bundle a single self-contained JS file for the embedded Hermes runtime (no module
// system, no Bun/node runtime). React + react-reconciler are bundled IN so the
// bytecode is self-contained. Optionally compiles to Hermes bytecode.
//
//   bun scripts/bundle-hermes.mjs [entry] [out.js] [--bytecode]
//
// Bun is used only as the dev bundler here; the output runs under Hermes.
import { homedir } from "node:os";
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, sep, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { reanimatedBunPlugin } from './reanimated-bun-plugin.mjs'
import { rngpuiHotUpdateAliasPlugin } from './hot-update-alias-plugin.mjs'
import { createReactRefreshSwcTransform } from './react-refresh-swc.mjs'
import { nativePackageExportsPlugin } from './native-package-exports-plugin.mjs'
import { hermescArgs } from './hermesc-args.mjs'

const root = resolve(import.meta.dirname, '..') // ts/
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const wantBytecode = process.argv.includes('--bytecode')
const entry = args[0] ? resolve(args[0]) : resolve(root, 'examples/hermes-smoke.tsx')
const outJs = args[1] ? resolve(args[1]) : '/tmp/hermes-bundle.js'
const mode = process.env.NODE_ENV || 'development'
const hotUpdate = process.env.RNGPUI_HOT_UPDATE === '1'
const refreshBootstrap = resolve(root, 'src/refresh.ts')
const refreshTransform = mode === 'development' ? createRefreshTransform() : null

const result = await Bun.build({
  entrypoints: [entry],
  target: 'browser', // neutral: no node/bun builtins, self-contained
  format: 'iife', // Hermes runs a script, not a module — no require()
  conditions: ['react-native'],
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode),
    __DEV__: mode === 'development' ? 'true' : 'false',
    // appearance conformance selects light or dark when producing its fixture so
    // the emitted bytecode remains deterministic across host system themes.
    'process.env.RNGPUI_INPUT_FIXTURE_APPEARANCE': JSON.stringify(
      process.env.RNGPUI_INPUT_FIXTURE_APPEARANCE || '',
    ),
  },
  // wire real react-native-reanimated@4 + worklets for the embedded Hermes target:
  // worklet babel transform (content-gated) + native-seam redirect to ts/src/reanimated.
  plugins: [
    ...(hotUpdate ? [rngpuiHotUpdateAliasPlugin()] : []),
    reanimatedBunPlugin({ rngTsRoot: root, transformSource: refreshTransform }),
    // last because bun onResolve hooks do not chain; the aliases above own
    // their package names before this handles react-native export conditions.
    nativePackageExportsPlugin({ root, name: 'rngpui native package exports' }),
  ],
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

// Async-generator downlevel: hermesc rejects `async function*`. Zero's b-tree + scan
// layer uses them; transform before bytecode compilation. Safe no-op otherwise.
if (wantBytecode) {
  try {
    const { transformAsync } = await import('@babel/core')
    const raw = readFileSync(outJs, 'utf8')
    const result = await transformAsync(raw, {
      filename: outJs,
      plugins: [require.resolve('@babel/plugin-transform-async-generator-functions')],
      sourceMaps: false,
      compact: false,
    })
    if (result?.code) {
      writeFileSync(outJs, result.code, 'utf8')
      console.log('[bundle-hermes] async-generator downlevel applied')
    }
  } catch (err) {
    console.error('[bundle-hermes] async-generator downlevel failed (non-fatal):', err.message)
  }
}

if (wantBytecode) {
  const hermesc = process.env.HERMESC || join(homedir(), 'github', 'hermes', 'build', 'bin', 'hermesc')
  const outHbc = outJs.replace(/\.js$/, '.hbc')
  const r = spawnSync(hermesc, [...hermescArgs, '-out', outHbc, outJs], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error('[bundle-hermes] hermesc failed')
    process.exit(1)
  }
  console.log(`[bundle-hermes] wrote ${outHbc} (Hermes bytecode)`)
}

// every app bundle needs the worklet/UI runtime bundle staged next to the service
// binary (plans/off-thread-reanimated.md). mtime-cached, so usually a no-op.
// guard: build-ui-runtime.mjs itself bundles ui-entry.ts through this script.
if (!hotUpdate && !entry.endsWith('/reanimated/ui-entry.ts')) {
  const ui = spawnSync('bun', ['scripts/build-ui-runtime.mjs'], { cwd: root, stdio: 'inherit' })
  if (ui.status !== 0) {
    console.error('[bundle-hermes] build-ui-runtime failed')
    process.exit(ui.status || 1)
  }
}

function createRefreshTransform() {
  const transform = createReactRefreshSwcTransform()
  return async (source, { filename, isTs, isJsx }) => {
    if (filename === refreshBootstrap || filename.includes(`${sep}node_modules${sep}`)) return source
    const code = await transform(source, { filename, isTs, isJsx })
    if (filename !== entry) return code
    if (!hotUpdate) return `import ${JSON.stringify(refreshBootstrap)};\n${code}`
    return `if (globalThis.__rngpuiRefreshReady !== true) throw new Error("RNGPUI Fast Refresh runtime is not installed");\n${code}`
  }
}
