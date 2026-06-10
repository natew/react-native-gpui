/**
 * THE off-thread reanimated proof (plans/off-thread-reanimated.md).
 *
 * A continuous reanimated animation (withRepeat(withTiming) on opacity, driven by a
 * useAnimatedStyle mapper — which lives on the worklet/UI runtime) runs while this
 * fixture BLOCKS THE REACT THREAD in a synchronous busy-loop for ~800ms. The driver
 * (scripts/offthread-stall-conformance.mjs) launches with RNGPUI_ANIM_TRACE=1 and
 * counts `[anim-trace] setNodeStyle` crossings that arrive between the STALL_START
 * and STALL_END markers. On the old single-runtime architecture the count is ~0 —
 * a blocked JS thread can't tick or flush an animation. With the worklet runtime,
 * the animation keeps producing frames throughout the stall.
 */
import { useEffect } from 'react'
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import { StyleSheet, Text, View, render } from '../src/index'

const STALL_MS = 800

function App() {
  const pulse = useSharedValue(0)

  const animatedStyle = useAnimatedStyle(() => {
    'worklet'
    return { opacity: 0.2 + 0.8 * pulse.value }
  })

  useEffect(() => {
    console.log('CONFORMANCE offthread-stall HOLDING')
    // continuous: ping-pong forever, ticked by the UI runtime's vsync rAF.
    pulse.value = withRepeat(withTiming(1, { duration: 240 }), -1, true)
    const timer = setTimeout(() => {
      // the animation is confirmed mid-flight (driver saw crossings after RUNNING).
      console.log('CONFORMANCE offthread-stall RUNNING')
      setTimeout(() => {
        console.log('CONFORMANCE offthread-stall STALL_START')
        const until = Date.now() + STALL_MS
        // synchronous busy-loop: the React thread can process NOTHING in here —
        // no timers, no rAF, no setNodeStyle flushes of its own.
        while (Date.now() < until) {
          // burn
        }
        console.log('CONFORMANCE offthread-stall STALL_END')
        setTimeout(() => {
          console.log('CONFORMANCE offthread-stall DONE')
        }, 300)
      }, 600)
    }, 400)
    return () => clearTimeout(timer)
  }, [pulse])

  return (
    <View style={styles.root}>
      <Animated.View nativeID="pulse-box" style={[styles.box, animatedStyle]} />
      <Text style={styles.label}>off-thread stall conformance</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#10141c',
    gap: 12,
  },
  box: {
    width: 120,
    height: 120,
    borderRadius: 16,
    backgroundColor: '#2f6fed',
  },
  label: {
    color: '#8fa3c0',
    fontSize: 13,
  },
})

render(<App />, { title: 'offthread-stall-conformance', width: 420, height: 320 })
