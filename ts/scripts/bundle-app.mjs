// Bundle a single self-contained JS file for the embedded JavaScriptCore runtime (no module
// system, no Bun/node runtime). React + react-reconciler are bundled IN so the
// source bundle is self-contained.
//
//   bun scripts/bundle-app.mjs [entry] [out.js]
//
// Bun is used only as the dev bundler here; the output runs under JavaScriptCore.
import { resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { reanimatedBunPlugin } from './reanimated-bun-plugin.mjs'
import { rngpuiHotUpdateAliasPlugin } from './hot-update-alias-plugin.mjs'
import { createReactRefreshSwcTransform } from './react-refresh-swc.mjs'
import { nativePackageExportsPlugin } from './native-package-exports-plugin.mjs'

const root = resolve(import.meta.dirname, '..') // ts/
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const entry = args[0] ? resolve(args[0]) : resolve(root, 'examples/engine-smoke.tsx')
const outJs = args[1] ? resolve(args[1]) : '/tmp/rngpui-bundle.js'
const mode = process.env.NODE_ENV || 'development'
const hotUpdate = process.env.RNGPUI_HOT_UPDATE === '1'
const refreshBootstrap = resolve(root, 'src/refresh.ts')
const refreshTransform = mode === 'development' ? createRefreshTransform() : null

const result = await Bun.build({
  entrypoints: [entry],
  target: 'browser', // neutral: no node/bun builtins, self-contained
  format: 'iife', // runs as a self-contained script
  conditions: ['react-native'],
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode),
    __DEV__: mode === 'development' ? 'true' : 'false',
    'import.meta.url': JSON.stringify('file://' + entry),
    'process.env.RNGPUI_INPUT_FIXTURE_APPEARANCE': JSON.stringify(
      process.env.RNGPUI_INPUT_FIXTURE_APPEARANCE || '',
    ),
  },
  plugins: [
    ...(hotUpdate ? [rngpuiHotUpdateAliasPlugin()] : []),
    reanimatedBunPlugin({ rngTsRoot: root, transformSource: refreshTransform }),
    nativePackageExportsPlugin({ root, name: 'rngpui native package exports' }),
  ],
  sourcemap: 'none',
  throw: false,
})

if (!result.success) {
  console.error('[bundle-app] build failed:')
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const code = await result.outputs.find((o) => o.kind === 'entry-point').text()
await Bun.write(outJs, code)
console.log(`[bundle-app] ${entry}`)
console.log(`[bundle-app] wrote ${outJs} (${(code.length / 1024).toFixed(0)} KB, NODE_ENV=${mode})`)

// every app bundle needs the worklet/UI runtime bundle staged next to the service
// binary. mtime-cached, so usually a no-op.
if (!hotUpdate && !entry.endsWith('/reanimated/ui-entry.ts')) {
  const ui = spawnSync('bun', ['scripts/build-ui-runtime.mjs'], { cwd: root, stdio: 'inherit' })
  if (ui.status !== 0) {
    console.error('[bundle-app] build-ui-runtime failed')
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
