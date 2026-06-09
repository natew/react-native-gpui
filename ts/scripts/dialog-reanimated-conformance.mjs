#!/usr/bin/env bun
// End-to-end conformance: a Tamagui Dialog with `animation="..."` (real
// @tamagui/animations-reanimated + react-native-reanimated@4 + worklets) ACTUALLY
// animates on react-native-gpui, through the off-thread overlay fast path.
//
// Isolation: builds against the GUI's full tamagui stack (gui/node_modules) into a TEMP
// bundle, using a TEMP reanimated prebuilt dir; runs the rng cargo release service. Does
// NOT write the shared app.hbc and does NOT sync into gui/node_modules.
//
// Steps:
//   1. prebuild reanimated + @tamagui/animations-reanimated from the gui into /tmp.
//   2. Bun-build gui/native-shell/dialog-reanimated-conformance.tsx with the gui's
//      react-native/react/single-React aliases + the rng reanimated plugin (worklet
//      transform on app/tamagui source, prebuilt-chunk aliasing) → temp HBC.
//   3. Run offscreen, poll RNGPUI_DUMP_TREE for the dialog-content style ramp, assert a
//      real spring ramp + setNodeStyle-dominated fast path.

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { reanimatedBunPlugin } from './reanimated-bun-plugin.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const tsRoot = resolve(here, '..')
const repoRoot = resolve(tsRoot, '..')
const guiRoot = resolve(process.env.RNGPUI_GUI_ROOT || '/Users/n8/agentbus/gui')
const rngEntry = resolve(tsRoot, 'src/index.ts')
const fixture = resolve(
  process.env.RNGPUI_DIALOG_FIXTURE || resolve(guiRoot, 'native-shell/dialog-reanimated-conformance.tsx'),
)

const outDir = process.argv[2] || '/tmp/rngpui-dialog-reanimated-conformance'
const prebuiltDir = '/tmp/gui-reanimated-prebuilt'
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const outJs = join(outDir, 'app.js')
const outHbc = join(outDir, 'app.hbc')
const dumpPath = join(outDir, 'tree.json')

if (!existsSync(fixture)) fail(`fixture missing: ${fixture}`)

// 1. prebuild reanimated + tamagui driver from the gui (skippable for debugging with a
// hand-instrumented chunk via RNGPUI_SKIP_PREBUILD=1).
if (process.env.RNGPUI_SKIP_PREBUILD !== '1') {
  log('prebuilding reanimated + @tamagui/animations-reanimated from the gui...')
  const pre = spawnSync('bun', ['scripts/prebuild-reanimated.mjs', prebuiltDir], {
    cwd: tsRoot,
    encoding: 'utf8',
    env: { ...process.env, RNGPUI_PREBUILD_RESOLVE_ROOT: guiRoot, NODE_ENV: 'production' },
  })
  if (pre.status !== 0) {
    process.stderr.write(pre.stdout || '')
    process.stderr.write(pre.stderr || '')
    fail('prebuild failed')
  }
} else {
  log('skipping prebuild (RNGPUI_SKIP_PREBUILD=1)')
}
if (!existsSync(join(prebuiltDir, 'tamagui-animations-reanimated.mjs'))) {
  fail('tamagui-animations-reanimated chunk not produced (is @tamagui/animations-reanimated installed in the gui?)')
}

// 2. bundle the fixture with the gui's tamagui stack + the rng reanimated plugin.
log('bundling the Dialog fixture...')
process.env.TAMAGUI_TARGET = 'native'
const guiRequire = createRequire(resolve(guiRoot, 'package.json'))
const guiReact = guiRequire.resolve('react')
const guiReactDir = dirname(guiReact)
const single = {
  react: guiReact,
  'react/jsx-runtime': join(guiReactDir, 'jsx-runtime.js'),
  'react/jsx-dev-runtime': join(guiReactDir, 'jsx-dev-runtime.js'),
}
const rnSvgShim = resolve(guiRoot, 'native-shell/react-native-svg.tsx')
const rnGestureShim = resolve(guiRoot, 'native-shell/react-native-gesture-handler.ts')
const rnCodegenShim = resolve(guiRoot, 'native-shell/react-native-codegenNativeComponent.ts')

// the prebuilt chunks (in /tmp) emit external `import … from "@tamagui/core"` etc.;
// Bun would resolve those from /tmp (no node_modules). Force every tamagui bare
// specifier to resolve from the GUI's node_modules, preferring the `.native.js` ESM
// entry (node resolution picks the CJS `index.cjs`, whose CJS-interop breaks under Bun:
// `import_react.forwardRef` lands on the version string). Map each to its native ESM.
function resolveGuiNative(spec) {
  // try `<pkgDir>/dist/esm/index.native.js` first, else fall back to node resolution.
  try {
    const cjs = guiRequire.resolve(spec)
    const pkgDir = cjs.includes('/dist/') ? cjs.slice(0, cjs.indexOf('/dist/')) : dirname(cjs)
    const nativeEsm = join(pkgDir, 'dist/esm/index.native.js')
    if (existsSync(nativeEsm)) return nativeEsm
    return cjs
  } catch {
    return null
  }
}
const guiPkgSpecifiers = ['tamagui', '@tamagui/core', '@tamagui/web', '@tamagui/native']
const guiResolved = new Map()
for (const spec of guiPkgSpecifiers) {
  const p = resolveGuiNative(spec)
  if (p) guiResolved.set(spec, p)
}

const aliases = {
  name: 'gui hermes aliases',
  setup(b) {
    b.onResolve({ filter: /^react(\/jsx-runtime|\/jsx-dev-runtime)?$/ }, (a) => ({ path: single[a.path] }))
    // react-native → gpui index. NOTE: the reanimated plugin also aliases this, but we
    // set aliasReactNative:false on it below so this single definition wins.
    b.onResolve({ filter: /^react-native$/ }, () => ({ path: rngEntry }))
    b.onResolve({ filter: /^react-native-gpui$/ }, () => ({ path: rngEntry }))
    b.onResolve({ filter: /^react-native\/Libraries\/Utilities\/codegenNativeComponent$/ }, () => ({ path: rnCodegenShim }))
    b.onResolve({ filter: /^react-native-svg$/ }, () => ({ path: rnSvgShim }))
    b.onResolve({ filter: /^react-native-gesture-handler$/ }, () => ({ path: rnGestureShim }))
    // tamagui bare specifiers (and their `/v5*` subpaths) → the gui's NATIVE ESM copies.
    b.onResolve({ filter: /^(tamagui|@tamagui\/)/ }, (a) => {
      if (guiResolved.has(a.path)) return { path: guiResolved.get(a.path) }
      try {
        const cjs = guiRequire.resolve(a.path)
        // `<pkg>/dist/cjs/X.cjs` → `<pkg>/dist/esm/X.native.js` when it exists.
        const nativeEsm = cjs.replace(/\/dist\/cjs\/([^/]+)\.cjs$/, '/dist/esm/$1.native.js')
        if (nativeEsm !== cjs && existsSync(nativeEsm)) return { path: nativeEsm }
        return { path: cjs }
      } catch {
        return undefined
      }
    })
  },
}

const result = await Bun.build({
  entrypoints: [fixture],
  target: 'browser',
  format: 'iife',
  conditions: ['react-native'],
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.TAMAGUI_TARGET': '"native"',
    __DEV__: 'false',
    'import.meta.env': '({})',
    'import.meta.url': '""',
  },
  plugins: [aliases, reanimatedBunPlugin({ rngTsRoot: tsRoot, resolveRoot: guiRoot, prebuiltDir, aliasReactNative: false })],
  sourcemap: 'none',
  throw: false,
})
if (!result.success) {
  for (const l of result.logs) console.error(String(l).slice(0, 300))
  fail('bundle failed')
}
const code = await result.outputs.find((o) => o.kind === 'entry-point').text()
await Bun.write(outJs, code)

const hermesc = process.env.HERMESC || '/Users/n8/github/hermes/build/bin/hermesc'
const hbc = spawnSync(hermesc, ['-emit-binary', '-O', '-out', outHbc, outJs], { encoding: 'utf8' })
if (hbc.status !== 0) {
  process.stderr.write(hbc.stderr || '')
  fail('hermesc failed')
}
log(`bundled ${(code.length / 1024).toFixed(0)} KB → ${outHbc}`)

// 3. run offscreen + assert.
const serviceBin = resolve(process.env.RNGPUI_SERVICE || resolve(repoRoot, 'rust', 'target', 'release', 'rngpui-service'))
if (!existsSync(serviceBin)) fail(`rngpui-service not found: ${serviceBin}`)

let output = ''
const child = spawn(serviceBin, [], {
  cwd: tsRoot,
  env: {
    ...process.env,
    RNGPUI_BUNDLE: outHbc,
    RNGPUI_NO_ACTIVATE: '1',
    RNGPUI_TEST_MODE: '1',
    RNGPUI_DUMP_TREE: dumpPath,
    RNGPUI_ANIM_TRACE: '1',
    RNGPUI_DIALOG_HOLD_MS: '600',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout?.on('data', (c) => (output += c.toString()))
child.stderr?.on('data', (c) => (output += c.toString()))

const samples = []
try {
  await waitFor(() => output.includes('CONFORMANCE dialog OPENING'), 7000, 'OPENING')
  const deadline = Date.now() + 2200
  while (Date.now() < deadline && !output.includes('CONFORMANCE dialog PASS')) {
    const s = readContentStyle(dumpPath)
    if (s) samples.push(s)
    await sleep(20)
  }
  await waitFor(() => output.includes('CONFORMANCE dialog PASS'), 4000, 'PASS')
} catch (e) {
  stop()
  fail(`${e instanceof Error ? e.message : String(e)}\n--- output (tail) ---\n${output.split('\n').slice(-40).join('\n')}`)
}
stop()

const applyTree = (output.match(/\[anim-trace\] applyTree/g) || []).length
const setNodeStyle = (output.match(/\[anim-trace\] setNodeStyle/g) || []).length

// the dialog content ramps opacity 0→1 (and scale/y). Count distinct opacity values.
const opacities = [...new Set(samples.map((s) => s.opacity).filter((v) => typeof v === 'number').map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b)
const widthsOrY = [...new Set(samples.map((s) => s.y).filter((v) => typeof v === 'number').map((v) => Math.round(v)))].sort((a, b) => a - b)

const rampOk =
  opacities.length > 3 && opacities[0] <= 0.4 && opacities[opacities.length - 1] >= 0.9
const fastPathOk = setNodeStyle >= 10 && setNodeStyle > applyTree * 2

console.log(
  [
    'DIALOG_REANIMATED_CONFORMANCE',
    `opacitySamples=${opacities.length}`,
    `opacities=[${opacities.join(',')}]`,
    `ySamples=${widthsOrY.length}`,
    `setNodeStyle=${setNodeStyle}`,
    `applyTree=${applyTree}`,
    `ramp=${rampOk ? 'PASS' : 'FAIL'}`,
    `fastPath=${fastPathOk ? 'PASS' : 'FAIL'}`,
  ].join(' '),
)
if (!rampOk) fail(`dialog opacity did not ramp: [${opacities.join(',')}]`)
if (!fastPathOk) fail(`fast path not proven: setNodeStyle=${setNodeStyle} applyTree=${applyTree}`)
console.log('DIALOG_REANIMATED_CONFORMANCE PASS')
process.exit(0)

function readContentStyle(path) {
  if (!existsSync(path)) return null
  let tree
  try {
    tree = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  const node = find(tree, 'dialog-content')
  if (!node) return null
  const style = node.style || {}
  // opacity is a direct style key; y/scale arrive via transform (not rendered by gpui)
  // or as top — read what the overlay surfaces.
  return { opacity: numOr(style.opacity), y: numOr(style.top) }
  function find(n, id) {
    if (n && typeof n === 'object') {
      if ((n.accessibility || {}).nativeID === id) return n
      for (const c of n.children || []) {
        const r = find(c, id)
        if (r) return r
      }
    }
    return null
  }
}
function numOr(v) {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}
function stop() {
  if (child.exitCode == null) {
    try {
      child.kill('SIGTERM')
    } catch {}
  }
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
async function waitFor(pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    if (child.exitCode != null) throw new Error(`service exited before ${label}`)
    await sleep(20)
  }
  throw new Error(`timed out waiting for ${label}`)
}
function log(m) {
  console.log(`[dialog-conformance] ${m}`)
}
function fail(m) {
  console.error(`DIALOG_REANIMATED_CONFORMANCE FAIL ${m}`)
  process.exit(1)
}
