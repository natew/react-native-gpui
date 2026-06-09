/**
 * Conformance fixture for REAL react-native-reanimated@4 + worklets on gpui.
 *
 * Run:
 *   bun run conformance:reanimated:diff
 *
 * An `Animated.View` whose width is driven by `useAnimatedStyle(() => ({ width:
 * withSpring(target) }))`. After a hold, the target flips and the spring ramps the
 * width across many frames. Each frame, reanimated's `_updateProps` crosses to the
 * host fast path (`__rngpui_setNodeStyle` → animated-style overlay → cx.notify), so
 * the width changes WITHOUT a React re-commit. The harness reads RNGPUI_DUMP_TREE
 * (which reflects the overlay-merged width) and asserts a real ramp — >3 distinct
 * rounded widths, not a snap.
 *
 * The "marker" node has nativeID "spring-box" so the harness can find it.
 */
import { useEffect, useRef, useState } from 'react'
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { StyleSheet, Text, View, render } from '../src/index'

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
const holdMs = numberEnv('RNGPUI_REANIMATED_HOLD_MS', 500)
const opacityAnim = process.env.RNGPUI_REANIMATED_OPACITY === '1'

function App() {
  const target = useSharedValue(startWidth)
  const [phase, setPhase] = useState('holding')

  const animatedStyle = useAnimatedStyle(() => {
    'worklet'
    if (opacityAnim) {
      return { opacity: withSpring(target.value === startWidth ? 0.2 : 1) }
    }
    return { width: withSpring(target.value, { damping: 14, stiffness: 90 }) }
  })

  useEffect(() => {
    console.log('CONFORMANCE reanimated HOLDING')
    const timer = setTimeout(() => {
      setPhase('running')
      console.log('CONFORMANCE reanimated RUNNING')
      target.value = endWidth
      // log a PASS marker after the spring has had time to settle.
      setTimeout(() => {
        setPhase('done')
        console.log('CONFORMANCE reanimated PASS')
      }, 2200)
    }, holdMs)
    return () => clearTimeout(timer)
  }, [target])

  return (
    <View style={s.root}>
      <View style={s.panel}>
        <Text style={s.heading} numberOfLines={1}>
          reanimated conformance
        </Text>
        <View style={s.rail}>
          <Animated.View nativeID="spring-box" style={[s.marker, animatedStyle]} />
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
  heading: {
    color: C.sub,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  rail: {
    width: 320,
    height: 52,
    borderRadius: 14,
    backgroundColor: C.rail,
    overflow: 'hidden',
    justifyContent: 'center',
    padding: 8,
  },
  marker: {
    width: startWidth,
    height: 36,
    borderRadius: 12,
    backgroundColor: C.marker,
  },
  value: { color: C.text, fontSize: 13, fontFamily: 'monospace' },
})

render(<App />, { width: 404, height: 180 })

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}
