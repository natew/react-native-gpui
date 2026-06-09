/**
 * Conformance fixture for the off-thread-reanimated FAST PATH (seam + Rust overlay),
 * exercised directly — without bundling full reanimated.
 *
 * Why direct: full react-native-reanimated does not bundle cleanly under Bun's
 * tree-shaker (it drops re-exported modules and leaves dangling namespace refs — see
 * the plugin notes + the handoff). The fast-path MECHANISM is the part this repo owns:
 * the TS seam's `global._updateProps` → rAF-coalesced `__rngpui_setNodeStyle` host
 * crossing → Rust animated-style overlay merged before layout → cx.notify WITHOUT a
 * React re-commit. This fixture drives that mechanism with a real spring integrator and
 * proves: (a) the box's width RAMPS across frames (overlay feeds layout), and (b) during
 * the animation only `setNodeStyle` fires, never `applyTree` (React doesn't re-commit).
 *
 * It uses the reanimated seam's `global._updateProps` exactly as upstream reanimated's
 * UpdatePropsManager.flush() calls it (`[{ shadowNodeWrapper: viewTag, updates }]`),
 * with viewTag = the animated node's host globalId (the seam maps it 1:1).
 */
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View, render } from '../src/index'
// install the seam (globals + global._updateProps fast path). In the full-reanimated
// path this is force-imported by the worklets stub; here we import it directly.
import '../src/reanimated/seam'

const C = {
  bg: '#f3f6fb',
  panel: '#ffffff',
  border: '#cad5e6',
  rail: '#d9e5f6',
  marker: '#2f6fed',
  text: '#172033',
  sub: '#66758c',
}

const startWidth = 60
const endWidth = 300
const holdMs = numberEnv('RNGPUI_ANIM_HOLD_MS', 400)

// A faithful critically-ish-damped spring integrator (same shape reanimated's
// withSpring uses: stiffness/damping/mass, rAF-stepped). Drives `onValue(width)` each
// frame until it settles, then `onDone()`.
function springTo(
  from: number,
  to: number,
  onValue: (v: number) => void,
  onDone: () => void,
  cfg = { stiffness: 90, damping: 14, mass: 1 },
): () => void {
  let pos = from
  let vel = 0
  let raf: number | null = null
  let last = performance.now()
  let stopped = false
  const step = (now: number) => {
    if (stopped) return
    const dt = Math.min(0.064, (now - last) / 1000)
    last = now
    // semi-implicit Euler, sub-stepped for stability.
    const steps = Math.max(1, Math.ceil(dt / 0.008))
    const h = dt / steps
    for (let i = 0; i < steps; i++) {
      const springF = -cfg.stiffness * (pos - to)
      const dampF = -cfg.damping * vel
      const a = (springF + dampF) / cfg.mass
      vel += a * h
      pos += vel * h
    }
    onValue(pos)
    const settled = Math.abs(pos - to) < 0.5 && Math.abs(vel) < 0.5
    if (settled) {
      pos = to
      onValue(to)
      onDone()
      return
    }
    raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
  return () => {
    stopped = true
    if (raf != null) cancelAnimationFrame(raf)
  }
}

declare const global: {
  _updateProps?: (ops: Array<{ shadowNodeWrapper: unknown; updates: Record<string, unknown> }>) => void
}

function App() {
  const boxRef = useRef<{ id: number } | null>(null)
  const [phase, setPhase] = useState('holding')

  useEffect(() => {
    console.log('CONFORMANCE anim-overlay HOLDING')
    const t = setTimeout(() => {
      const viewTag = boxRef.current?.id
      if (typeof viewTag !== 'number') {
        console.log('CONFORMANCE anim-overlay FAIL no-viewtag')
        return
      }
      setPhase('running')
      console.log(`CONFORMANCE anim-overlay RUNNING viewTag=${viewTag}`)
      const update = global._updateProps
      if (typeof update !== 'function') {
        console.log('CONFORMANCE anim-overlay FAIL no-updateProps')
        return
      }
      // drive the spring; each frame push the width through the SEAM exactly the way
      // reanimated's UpdatePropsManager.flush does — one op per node.
      springTo(
        startWidth,
        endWidth,
        (w) => update([{ shadowNodeWrapper: viewTag, updates: { width: Math.round(w) } }]),
        () => {
          // clear the overlay (mirrors cancelAnimation / settle) by pushing the final
          // value once more, then report PASS.
          update([{ shadowNodeWrapper: viewTag, updates: { width: endWidth } }])
          setPhase('done')
          console.log('CONFORMANCE anim-overlay PASS')
        },
      )
    }, holdMs)
    return () => clearTimeout(t)
  }, [])

  return (
    <View style={s.root}>
      <View style={s.panel}>
        <Text style={s.heading} numberOfLines={1}>
          anim-overlay conformance
        </Text>
        <View style={s.rail}>
          <View ref={boxRef as never} nativeID="spring-box" style={s.marker} />
        </View>
        <Text style={s.value} numberOfLines={1}>
          phase={phase}
        </Text>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, padding: 22 },
  panel: {
    width: 360,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.panel,
    padding: 16,
    gap: 14,
  },
  heading: { color: C.sub, fontSize: 12, fontWeight: '800', letterSpacing: 0.8 },
  rail: {
    width: 320,
    height: 52,
    borderRadius: 14,
    backgroundColor: C.rail,
    overflow: 'hidden',
    justifyContent: 'center',
    padding: 8,
  },
  marker: { width: startWidth, height: 36, borderRadius: 12, backgroundColor: C.marker },
  value: { color: C.text, fontSize: 13, fontFamily: 'monospace' },
})

render(<App />, { width: 404, height: 180 })

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}
