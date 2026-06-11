/**
 * Conformance fixture for the renderer→JS pseudo lane (plans/tamagui-pseudo-hook.md, the
 * rngpui half). A box subscribes to its own native hover/press flips through
 * `platformDriver.pseudo.subscribe` — the SAME entry point tamagui's setupPlatformDriver
 * consumes. The driver:
 *   - sets the per-node opt-in (`pseudoEvents`), so the host emits a coalesced `pseudo`
 *     event on each hover/press flip of the box's hitbox,
 *   - routes that event to the listener WITHOUT the React event path.
 *
 * The fixture proves the contract by logging every listener firing and the React render
 * count. The driver (pseudo-driver-conformance.mjs) drives a REAL offscreen pointer move
 * over the box, presses it, then moves away, and asserts the listener saw hover and
 * press state changes while the React render count never changed.
 */
import { useEffect, useRef } from 'react'
import { StyleSheet, Text, View, platformDriver, render } from '../src/index'

let renderCount = 0

function App() {
  // bump a module counter on every React render so the gate can prove a hover does NOT
  // cause a React commit. useRef (not state) so reading/incrementing it never re-renders.
  renderCount++
  const boxRef = useRef<{ id: number } | null>(null)

  useEffect(() => {
    const inst = boxRef.current
    if (!inst || typeof inst.id !== 'number') {
      console.log('CONFORMANCE pseudo-driver FAIL no-instance')
      return
    }
    console.log(`CONFORMANCE pseudo-driver READY id=${inst.id} renders=${renderCount}`)
    // report the box's window-coordinate rect so the gate can aim the real pointer. This
    // also drives the layout-subscription path, which forces the offscreen window to paint.
    const measurable = inst as unknown as {
      measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void
    }
    measurable.measureInWindow?.((x, y, w, h) => {
      console.log(`CONFORMANCE pseudo-driver BOX x=${x} y=${y} w=${w} h=${h}`)
    })
    const dispose = platformDriver.pseudo.subscribe(inst, ({ hovered, pressed }) => {
      // log the absolute state + the CURRENT render count so the gate proves the listener
      // fired without bumping renders (a React commit would increment renderCount).
      console.log(`CONFORMANCE pseudo-driver FLIP hovered=${hovered} pressed=${pressed} renders=${renderCount}`)
    })
    return dispose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <View style={s.root}>
      <View style={s.panel}>
        <Text style={s.heading} numberOfLines={1}>
          pseudo-driver conformance
        </Text>
        <View ref={boxRef as never} nativeID="pseudo-box" style={s.box} />
        <Text style={s.value} numberOfLines={1}>
          pseudo lane
        </Text>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f3f6fb', padding: 22 },
  panel: {
    width: 360,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#cad5e6',
    backgroundColor: '#ffffff',
    padding: 16,
    gap: 14,
  },
  heading: { color: '#66758c', fontSize: 12, fontWeight: '800', letterSpacing: 0.8 },
  box: { width: 200, height: 80, borderRadius: 12, backgroundColor: '#2f6fed' },
  value: { color: '#172033', fontSize: 13, fontFamily: 'monospace' },
})

render(<App />, { width: 404, height: 200 })
