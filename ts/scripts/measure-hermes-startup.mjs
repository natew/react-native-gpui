// Measure single-process Hermes cold start: process launch → first painted frame.
// Uses the invisible on-screen capture window (paints, no focus theft) and reads the
// binary's "[startup] first render +Xms" marker (RNGPUI_STARTUP_TIMING).
//
//   node scripts/measure-hermes-startup.mjs <binary> <bundle.js|.hbc> [runs]
import { spawn } from 'node:child_process'

const bin = process.argv[2]
const bundle = process.argv[3]
const runs = Number(process.argv[4] || 6)

function once() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint()
    const child = spawn(bin, [], {
      env: {
        ...process.env,
        RNGPUI_BUNDLE: bundle,
        RNGPUI_STARTUP_TIMING: '1',
        RNGPUI_CAPTURE_ONSCREEN: '1',
        RNGPUI_OPAQUE_WINDOW: '1',
        RNGPUI_CAPTURE_ALPHA: '0.02',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let buf = ''
    let done = false
    child.stderr.on('data', (c) => {
      buf += c.toString()
      const m = buf.match(/\[startup\] first render \+([\d.]+)ms/)
      if (m && !done) {
        done = true
        const wall = Number(process.hrtime.bigint() - t0) / 1e6
        try { child.kill('SIGTERM') } catch {}
        resolve({ wall, internal: Number(m[1]) })
      }
    })
    child.on('exit', () => { if (!done) resolve(null) })
  })
}

const results = []
for (let i = 0; i < runs; i++) {
  const r = await once()
  results.push(r)
  console.log(`run ${i + 1}: ${r ? `wall ${r.wall.toFixed(0)}ms · internal ${r.internal.toFixed(0)}ms` : 'FAILED (no first-render)'}`)
  await new Promise((res) => setTimeout(res, 300))
}
const ok = results.filter(Boolean)
if (!ok.length) { console.log('no successful runs'); process.exit(1) }
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]
const stat = (vals) => `min ${Math.min(...vals).toFixed(0)} · median ${med(vals).toFixed(0)} · max ${Math.max(...vals).toFixed(0)} ms`
console.log('\n' + '─'.repeat(56))
console.log(`bundle: ${bundle}`)
console.log(`wall (launch → first paint):  ${stat(ok.map((r) => r.wall))}`)
console.log(`internal (main → first paint): ${stat(ok.map((r) => r.internal))}`)
