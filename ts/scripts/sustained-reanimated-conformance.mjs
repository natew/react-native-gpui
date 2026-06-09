#!/usr/bin/env bun
// Sustained multi-component reanimated conformance — reproduces / guards against the
// live-app FREEZE that a single 600ms dialog never exposes.
//
// Builds gui/native-shell/sustained-reanimated-conformance.tsx through the SAME pipeline
// the real desktop app uses — React Compiler (babel-plugin-react-compiler) on app source
// THEN the reanimated worklet transform — against the gui's full tamagui stack, into a
// TEMP bundle (isolation: no shared app.hbc, no gui/node_modules sync). Runs it offscreen
// for several seconds of repeated open/close with MANY animated components, with
// RNGPUI_PERF_TRACE on, and asserts:
//   - jsBlock stays bounded (no 60fps full-tree re-render storm → freeze),
//   - the frame loop goes IDLE after the scene settles (no ongoing setNodeStyle/applyTree),
//   - setNodeStyle dominates / applyTree stays flat during animation,
//   - a synthetic tap AFTER settle stays low-latency.

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { reanimatedBunPlugin } from './reanimated-bun-plugin.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const tsRoot = resolve(here, '..')
const repoRoot = resolve(tsRoot, '..')
const guiRoot = resolve(process.env.RNGPUI_GUI_ROOT || '/Users/n8/agentbus/gui')
const rngEntry = resolve(tsRoot, 'src/index.ts')
const fixture = resolve(
  process.env.RNGPUI_SUSTAINED_FIXTURE || resolve(guiRoot, 'native-shell/sustained-reanimated-conformance.tsx'),
)

const outDir = process.argv[2] || '/tmp/rngpui-sustained-reanimated-conformance'
const prebuiltDir = '/tmp/gui-reanimated-prebuilt'
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const outJs = join(outDir, 'app.js')
const outHbc = join(outDir, 'app.hbc')
const dumpPath = join(outDir, 'tree.json')
const controlSocket = join(outDir, 'control.sock')

if (!existsSync(fixture)) fail(`fixture missing: ${fixture}`)

// 1. prebuild reanimated + tamagui driver from the gui (skippable for debugging).
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
}

// 2. bundle with the gui's react-compiler plugin + the rng reanimated plugin, in the
// SAME ORDER the gui bundler uses (compiler before reanimated). This is the load-order
// interaction the user lands; if the worklet transform never runs on compiled app
// source, __closure goes missing and the freeze/snap appears here.
log('bundling the sustained scene (react-compiler + reanimated)...')
process.env.TAMAGUI_TARGET = 'native'
const guiRequire = createRequire(resolve(guiRoot, 'package.json'))
const guiReact = guiRequire.resolve('react')
const guiReactDir = dirname(guiReact)
const single = {
  react: guiReact,
  'react/jsx-runtime': join(guiReactDir, 'jsx-runtime.js'),
  'react/jsx-dev-runtime': join(guiReactDir, 'jsx-dev-runtime.js'),
  'react/compiler-runtime': join(guiReactDir, 'compiler-runtime.js'),
}
// identical to dialog-reanimated-conformance.mjs (proven): prefer `<pkg>/dist/esm/
// index.native.js` for bare specifiers, and `dist/cjs/X.cjs → dist/esm/X.native.js` for
// subpaths, so tamagui's CJS-interop (which breaks under Bun) is never bundled.
function resolveGuiNative(spec) {
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
const guiResolved = new Map()
for (const spec of ['tamagui', '@tamagui/core', '@tamagui/web', '@tamagui/native']) {
  const p = resolveGuiNative(spec)
  if (p) guiResolved.set(spec, p)
}
const rnSvgShim = resolve(guiRoot, 'native-shell/react-native-svg.tsx')
const rnGestureShim = resolve(guiRoot, 'native-shell/react-native-gesture-handler.ts')
const rnCodegenShim = resolve(guiRoot, 'native-shell/react-native-codegenNativeComponent.ts')
const aliases = {
  name: 'gui hermes aliases',
  setup(b) {
    b.onResolve({ filter: /^react(\/jsx-runtime|\/jsx-dev-runtime|\/compiler-runtime)?$/ }, (a) => ({ path: single[a.path] }))
    b.onResolve({ filter: /^react-native$/ }, () => ({ path: rngEntry }))
    b.onResolve({ filter: /^react-native-gpui$/ }, () => ({ path: rngEntry }))
    b.onResolve({ filter: /^react-native\/Libraries\/Utilities\/codegenNativeComponent$/ }, () => ({ path: rnCodegenShim }))
    b.onResolve({ filter: /^react-native-svg$/ }, () => ({ path: rnSvgShim }))
    b.onResolve({ filter: /^react-native-gesture-handler$/ }, () => ({ path: rnGestureShim }))
    b.onResolve({ filter: /^(tamagui|@tamagui\/)/ }, (a) => {
      if (guiResolved.has(a.path)) return { path: guiResolved.get(a.path) }
      try {
        const cjs = guiRequire.resolve(a.path)
        const nativeEsm = cjs.replace(/\/dist\/cjs\/([^/]+)\.cjs$/, '/dist/esm/$1.native.js')
        if (nativeEsm !== cjs && existsSync(nativeEsm)) return { path: nativeEsm }
        return { path: cjs }
      } catch {
        return undefined
      }
    })
  },
}

// the gui's react-compiler plugin (replicated to keep the harness self-contained).
const { transformAsync } = await import(guiRequire.resolve('@babel/core'))
const appDirs = ['interface', 'features', 'app', 'native-shell', 'tamagui'].map((d) => guiRoot + sep + d + sep)
const reactCompiler = {
  name: 'react-compiler',
  setup(b) {
    b.onLoad({ filter: /\.[jt]sx?$/ }, async (args) => {
      const path = args.path
      if (path.includes(`${sep}node_modules${sep}`)) return undefined
      if (!appDirs.some((dir) => path.startsWith(dir))) return undefined
      const source = readFileSync(path, 'utf8')
      const isTs = /\.tsx?$/.test(path)
      const isJsx = /x$/.test(path)
      const result = await transformAsync(source, {
        filename: path,
        babelrc: false,
        configFile: false,
        sourceMaps: false,
        parserOpts: { plugins: [...(isTs ? ['typescript'] : []), ...(isJsx ? ['jsx'] : [])] },
        plugins: [[guiRequire.resolve('babel-plugin-react-compiler'), { target: '19' }]],
        presets: isTs ? [[guiRequire.resolve('@babel/preset-typescript'), { isTSX: isJsx, allExtensions: true }]] : [],
      })
      if (!result || result.code == null) return undefined
      return { contents: result.code, loader: isJsx ? 'jsx' : 'js' }
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
  // ORDER MATTERS: aliases, then react-compiler (app source), then reanimated (worklet
  // transform on app + tamagui driver source + prebuilt-chunk aliasing). This mirrors
  // gui/native-shell/scripts/bundle-app-hermes.mjs with the reanimated plugin appended.
  plugins: [aliases, reactCompiler, reanimatedBunPlugin({ rngTsRoot: tsRoot, resolveRoot: guiRoot, prebuiltDir, aliasReactNative: false })],
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

// 3. run offscreen with perf trace; watch jsBlock + setNodeStyle/applyTree timeline.
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
    RNGPUI_PERF_TRACE: '1',
    RNGPUI_PERF_TRACE_MS: '8', // log any js-block >= 8ms
    RNGPUI_CONTROL_SOCKET: controlSocket,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout?.on('data', (c) => (output += c.toString()))
child.stderr?.on('data', (c) => (output += c.toString()))

// timestamped marks so we can window "during animation" vs "after settle".
const marks = []
const onLine = () => {
  const at = Date.now()
  const lines = output.split('\n')
  for (let i = marks.lastSeen ?? 0; i < lines.length; i++) {
    if (lines[i].includes('[anim-trace] setNodeStyle')) marks.push({ at, kind: 'setNodeStyle' })
    else if (lines[i].includes('[anim-trace] applyTree')) marks.push({ at, kind: 'applyTree' })
    else if (lines[i].includes('[perf] js-block')) {
      const m = /js-block ([0-9.]+)ms/.exec(lines[i])
      if (m) marks.push({ at, kind: 'jsBlock', ms: Number(m[1]) })
    }
  }
  marks.lastSeen = lines.length
}
const poll = setInterval(onLine, 30)

// realtap helper — dispatches a REAL gpui pointer event through hitbox hit-test (NOT
// synth_tap) and times the round-trip. The valid responsiveness signal under animation.
async function realtap(x, y) {
  const net = await import('node:net')
  return new Promise((resolveP) => {
    const t0 = Date.now()
    const sock = net.connect(controlSocket)
    let buf = ''
    const done = (v) => {
      try {
        sock.end()
      } catch {}
      resolveP(v)
    }
    sock.on('error', () => done(null))
    sock.on('connect', () => sock.write(JSON.stringify({ reqId: 1, $cmd: 'realtap', x, y }) + '\n'))
    sock.on('data', (d) => {
      buf += d.toString()
      if (buf.includes('\n')) {
        try {
          const r = JSON.parse(buf.trim())
          r.latencyMs = Date.now() - t0
          done(r)
        } catch {
          done(null)
        }
      }
    })
    setTimeout(() => done(null), 2500)
  })
}

function tapTargetCenter() {
  if (!existsSync(dumpPath)) return null
  let tree
  try {
    tree = JSON.parse(readFileSync(dumpPath, 'utf8'))
  } catch {
    return null
  }
  const find = (n) => {
    if (n && typeof n === 'object') {
      if ((n.accessibility || {}).nativeID === 'tap-target' && n.bounds && n.bounds.width > 0) return n.bounds
      for (const c of n.children || []) {
        const r = find(c)
        if (r) return r
      }
    }
    return null
  }
  const b = find(tree)
  return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null
}

try {
  await waitFor(() => output.includes('CONFORMANCE sustained READY'), 8000, 'READY')
  const startAt = Date.now()

  // ── REAL responsiveness probe DURING the animation storm ──
  // Repeatedly realtap the stable button while many components spring. Each tap must fire
  // its handler (a frozen/contended main thread would drop them or answer slowly). This is
  // the on-screen-equivalent signal socket taps are structurally blind to.
  const realtapResults = []
  const realtapDeadline = startAt + 5000
  await waitFor(() => output.includes('CONFORMANCE sustained OPEN'), 6000, 'first OPEN')
  while (Date.now() < realtapDeadline && !output.includes('CONFORMANCE sustained SETTLED')) {
    const c = tapTargetCenter()
    if (c) {
      const before = (output.match(/SUSTAINED TAP FIRED/g) || []).length
      const r = await realtap(c.x, c.y)
      await sleep(40)
      const after = (output.match(/SUSTAINED TAP FIRED/g) || []).length
      if (r) realtapResults.push({ fired: r.handlerFired, latencyMs: r.latencyMs, delivered: after > before })
    }
    await sleep(260)
  }

  await waitFor(() => output.includes('CONFORMANCE sustained SETTLED'), 40000, 'SETTLED')
  const settledAt = Date.now()
  // observe an IDLE window of ~2s AFTER the scene settles. THE freeze signal: if the
  // off-thread loop never terminates, setNodeStyle ops keep firing here and js-block
  // lines never stop. A healthy run goes silent (the rAF clock stops, the JS thread
  // yields). Socket taps are deliberately NOT used — they bypass GPUI's hit-test/event
  // loop (invoke handlers straight off the serialized tree) so they answer even when the
  // real app is frozen (see the coordinator note in service.rs DebugTap).
  await sleep(2000)
  clearInterval(poll)
  onLine()

  // ── ops-over-time curve (250ms buckets) ──
  const BUCKET = 250
  const t0 = startAt
  const buckets = new Map() // bucketIndex -> { setNodeStyle, applyTree, jsBlockMs }
  for (const m of marks) {
    const b = Math.floor((m.at - t0) / BUCKET)
    const cur = buckets.get(b) ?? { setNodeStyle: 0, applyTree: 0, jsBlockMax: 0 }
    if (m.kind === 'setNodeStyle') cur.setNodeStyle++
    else if (m.kind === 'applyTree') cur.applyTree++
    else if (m.kind === 'jsBlock') cur.jsBlockMax = Math.max(cur.jsBlockMax, m.ms)
    buckets.set(b, cur)
  }
  const lastBucket = Math.floor((Date.now() - t0) / BUCKET)
  const curve = []
  for (let b = 0; b <= lastBucket; b++) {
    const c = buckets.get(b) ?? { setNodeStyle: 0, applyTree: 0, jsBlockMax: 0 }
    curve.push(c)
  }

  const maxJsBlock = marks.filter((m) => m.kind === 'jsBlock').reduce((a, m) => Math.max(a, m.ms), 0)
  const setNodeStyle = marks.filter((m) => m.kind === 'setNodeStyle').length
  const applyTree = marks.filter((m) => m.kind === 'applyTree').length

  // IDLE assertion: the buckets AFTER settle+400ms must have zero setNodeStyle (the
  // animation loop terminated). Count any op activity in the post-settle window.
  const idleCutoffBucket = Math.floor((settledAt + 400 - t0) / BUCKET)
  const postSettleOps = curve.slice(idleCutoffBucket).reduce((a, c) => a + c.setNodeStyle + c.applyTree, 0)
  const postSettleJsBlocks = curve.slice(idleCutoffBucket).filter((c) => c.jsBlockMax > 0).length

  // print the curve compactly: setNodeStyle per 250ms bucket (S=setNodeStyle, a=applyTree)
  const curveStr = curve.map((c) => `${c.setNodeStyle}${c.applyTree ? 'a' + c.applyTree : ''}`).join(' ')

  // ── realtap (real responsiveness DURING animation) analysis ──
  const realtaps = realtapResults.length
  const realtapsFired = realtapResults.filter((r) => r.fired && r.delivered).length
  const maxRealtapLatency = realtapResults.reduce((a, r) => Math.max(a, r.latencyMs), 0)

  const jsBlockOk = maxJsBlock < 60
  const idleOk = postSettleOps === 0 && postSettleJsBlocks === 0
  const fastPathOk = setNodeStyle >= 40 && setNodeStyle > applyTree
  // every real click during the storm must reach + fire its handler, fast. A frozen /
  // main-thread-contended app drops them or answers slowly. This is THE freeze signal.
  const realtapOk = realtaps >= 3 && realtapsFired === realtaps && maxRealtapLatency < 150

  console.log(`[sustained] ops/250ms (S=setNodeStyle,aN=applyTree): ${curveStr}`)
  console.log(
    [
      'SUSTAINED_REANIMATED_CONFORMANCE',
      `maxJsBlock=${maxJsBlock.toFixed(1)}ms`,
      `setNodeStyle=${setNodeStyle}`,
      `applyTree=${applyTree}`,
      `postSettleOps=${postSettleOps}`,
      `postSettleJsBlocks=${postSettleJsBlocks}`,
      `realtapsFired=${realtapsFired}/${realtaps}`,
      `maxRealtapLatency=${maxRealtapLatency}ms`,
      `jsBlock=${jsBlockOk ? 'PASS' : 'FAIL'}`,
      `idle=${idleOk ? 'PASS' : 'FAIL'}`,
      `fastPath=${fastPathOk ? 'PASS' : 'FAIL'}`,
      `realtap=${realtapOk ? 'PASS' : 'FAIL'}`,
    ].join(' '),
  )
  stop()
  if (!jsBlockOk) fail(`jsBlock spiked to ${maxJsBlock.toFixed(1)}ms (>=60) — re-render storm / freeze`)
  if (!idleOk) fail(`frame loop did NOT go idle: ${postSettleOps} ops + ${postSettleJsBlocks} js-block buckets after settle (continuous rAF = the freeze)`)
  if (!fastPathOk) fail(`fast path not dominant: setNodeStyle=${setNodeStyle} applyTree=${applyTree}`)
  if (!realtapOk)
    fail(
      `real clicks did NOT stay responsive during animation: ${realtapsFired}/${realtaps} fired, maxLatency=${maxRealtapLatency}ms (the on-screen freeze signal)`,
    )
  console.log('SUSTAINED_REANIMATED_CONFORMANCE PASS')
  process.exit(0)
} catch (e) {
  clearInterval(poll)
  stop()
  fail(`${e instanceof Error ? e.message : String(e)}\n--- output (tail) ---\n${output.split('\n').slice(-50).join('\n')}`)
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
    await sleep(25)
  }
  throw new Error(`timed out waiting for ${label}`)
}
function log(m) {
  console.log(`[sustained] ${m}`)
}
function fail(m) {
  console.error(`SUSTAINED_REANIMATED_CONFORMANCE FAIL ${m}`)
  process.exit(1)
}
