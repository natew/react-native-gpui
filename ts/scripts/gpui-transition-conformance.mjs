// Conformance: the declarative gpui animation driver's NATIVE consumer (rust
// anim_overlay_tween). A committed style carrying a `_gpuiTransition` block must make the
// renderer TWEEN a changed animatable key across frames (the CSS-transition analog),
// driven entirely in Rust — not snap to the new value in one commit.
//
// Drives examples/gpui-transition-conformance.tsx via `rngpui trace ... --action tap` and
// asserts the box's width ramps 60→300: many monotonic intermediate frames (proving a
// real tween), settling exactly at the target, with no overshoot (timing curve).
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(msg) {
  console.error(`GPUI_TRANSITION_CONFORMANCE_FAIL ${msg}`)
  process.exit(1)
}

let out
try {
  out = execFileSync(
    'bun',
    [
      'cli/bin.ts',
      'trace',
      'gpui-box',
      '--keys',
      'width',
      '--launch',
      'examples/gpui-transition-conformance.tsx',
      '--action',
      'tap gpui-box',
      '--ms',
      '800',
      '--json',
    ],
    { cwd: tsRoot, encoding: 'utf8', timeout: 120000 },
  )
} catch (e) {
  fail(`trace failed: ${e.message || e}`)
}

let d
try {
  d = JSON.parse(out)
} catch {
  fail('trace produced no/invalid json')
}

const series = (d.series || []).find((s) => String(s.key).endsWith('.width'))
if (!series) fail('no width series — the native tween never wrote the overlay (snap, not tween)')

const samples = (d.samples || []).filter((s) => s.k === 'width').map((s) => s.v)
if (samples.length < 10) fail(`too few ramp frames (${samples.length}) — expected a multi-frame tween`)

// settled exactly at the target
if (Math.abs(series.last - 300) > 0.5) fail(`did not settle at 300 (last=${series.last})`)
// started well below the target — proves it ramped from the old value, not snapped
if (series.min > 150) fail(`min ${series.min.toFixed(1)} too high — looks like a snap, not a ramp from 60`)
// timing curve: monotonic non-decreasing, no overshoot
for (let i = 1; i < samples.length; i++) {
  if (samples[i] < samples[i - 1] - 0.5) fail(`non-monotonic at ${i}: ${samples[i - 1]}→${samples[i]}`)
}
if (series.overshoots > 0) fail(`unexpected overshoot (${series.overshoots}) for a timing curve`)

console.log(
  `GPUI_TRANSITION_CONFORMANCE_PASS frames=${samples.length} ${series.min.toFixed(0)}→${series.last.toFixed(0)} spark=${series.spark}`,
)
