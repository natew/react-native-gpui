// Bundle a single self-contained JS file for the embedded Hermes runtime (no module
// system, no Bun/node runtime). React + react-reconciler are bundled IN so the
// bytecode is self-contained. Optionally compiles to Hermes bytecode.
//
//   bun scripts/bundle-hermes.mjs [entry] [out.js] [--bytecode]
//
// Bun is used only as the dev bundler here; the output runs under Hermes.
import { readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { reanimatedBunPlugin } from './reanimated-bun-plugin.mjs'
import { rngpuiHotUpdateAliasPlugin } from './hot-update-alias-plugin.mjs'
import { createReactRefreshSwcTransform } from './react-refresh-swc.mjs'

const root = resolve(import.meta.dirname, '..') // ts/
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const wantBytecode = process.argv.includes('--bytecode')
const entry = args[0] ? resolve(args[0]) : resolve(root, 'examples/hermes-smoke.tsx')
const outJs = args[1] ? resolve(args[1]) : '/tmp/hermes-bundle.js'
const mode = process.env.NODE_ENV || 'development'
const hotUpdate = process.env.RNGPUI_HOT_UPDATE === '1'
const refreshPlugin = mode === 'development' ? reactRefreshPlugin({ roots: [dirname(entry)] }) : null

const result = await Bun.build({
  entrypoints: [entry],
  target: 'browser', // neutral: no node/bun builtins, self-contained
  format: 'iife', // Hermes runs a script, not a module — no require()
  conditions: ['react-native'],
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode),
    __DEV__: mode === 'development' ? 'true' : 'false',
    // the Hermes host provides an empty process.env at runtime, so conformance
    // fixtures can't read host env vars live. Inline the appearance the gate wants
    // (light|dark) at bundle time so a single fixture can render either theme.
    'process.env.RNGPUI_INPUT_FIXTURE_APPEARANCE': JSON.stringify(
      process.env.RNGPUI_INPUT_FIXTURE_APPEARANCE || '',
    ),
  },
  // wire real react-native-reanimated@4 + worklets for the embedded Hermes target:
  // worklet babel transform (content-gated) + native-seam redirect to ts/src/reanimated.
  plugins: [
    ...(hotUpdate ? [rngpuiHotUpdateAliasPlugin()] : []),
    ...(refreshPlugin ? [refreshPlugin] : []),
    reanimatedBunPlugin({ rngTsRoot: root }),
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

function reactRefreshPlugin({ roots }) {
  const normalizedRoots = roots.map((dir) => resolve(dir) + sep)
  const transform = createReactRefreshSwcTransform()
  return {
    name: 'rngpui-react-refresh',
    setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        if (args.path.includes(`${sep}node_modules${sep}`)) return undefined
        if (!normalizedRoots.some((dir) => args.path.startsWith(dir))) return undefined
        const isTs = /\.[cm]?tsx?$/.test(args.path)
        const isJsx = /x$/.test(args.path)
        const source = readFileSync(args.path, 'utf8')
        return {
          contents: await transform(source, { filename: args.path, isTs, isJsx }),
          loader: 'js',
        }
      })
    },
  }
}
