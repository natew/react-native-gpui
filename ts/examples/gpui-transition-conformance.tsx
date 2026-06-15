/**
 * Conformance fixture for the DECLARATIVE gpui animation driver's NATIVE CONSUMER
 * (rust `anim_overlay_tween`). A committed style carrying a `_gpuiTransition` block must
 * make the renderer TWEEN changed animatable keys old→new over the declared
 * duration/easing — the CSS-transition analog, driven entirely in Rust (no JS per-frame,
 * no worklet). This is what makes the Tamagui "gpui" animation driver actually animate.
 *
 * The Tamagui gpui driver emits exactly this `_gpuiTransition` shape onto the committed
 * style; this fixture emits it directly so the native consumer can be traced without the
 * full Tamagui stack. After a hold the box's `width` jumps 60→300 in ONE React commit;
 * the native tween must ramp it across frames instead of snapping.
 *
 * Proof:
 *   rngpui trace gpui-box --launch examples/gpui-transition-conformance.tsx --ms 1200
 * should show `width` taking many intermediate values between 60 and 300 (a ramp), not a
 * single 60→300 jump.
 */
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View, render } from '../src/index'

const startWidth = 60
const endWidth = 300

// the descriptor the Tamagui gpui driver attaches to style._gpuiTransition.
const gpuiTransition = {
  keys: ['all'],
  byKey: {},
  default: { duration: 300, easing: 'ease-out', type: 'timing' },
  delay: 0,
}

// tap-driven so a tracer can arm BEFORE the change and capture the full ramp
// deterministically: `rngpui trace gpui-box --action "tap gpui-box"`.
function App() {
  const [wide, setWide] = useState(false)
  const w = wide ? endWidth : startWidth
  return (
    <View style={s.root}>
      <View style={s.panel}>
        <Text style={s.heading} numberOfLines={1}>
          gpui-transition conformance
        </Text>
        <View style={s.rail}>
          {/* width flips in one commit; _gpuiTransition makes the renderer tween it. */}
          <Pressable
            nativeID="gpui-box"
            onPress={() => setWide((v) => !v)}
            style={{ ...s.marker, width: w, _gpuiTransition: gpuiTransition } as never}
          />
        </View>
        <Text style={s.value} numberOfLines={1}>
          w={w}
        </Text>
      </View>
    </View>
  )
}

const C = {
  bg: '#f3f6fb',
  panel: '#ffffff',
  border: '#cad5e6',
  rail: '#d9e5f6',
  marker: '#2f6fed',
  text: '#172033',
  sub: '#66758c',
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
