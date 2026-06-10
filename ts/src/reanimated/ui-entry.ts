// reanimated worklet/UI runtime entry — bundled standalone as dist/ui-runtime.js
// and evaluated by the SECOND Hermes runtime (rust hermes::start_ui, thread
// "hermes-ui"). See plans/off-thread-reanimated.md.
//
// This bundle is app-independent library code. It provides everything a
// dispatched worklet needs to execute here:
//  - the seam (KIND=2 globals: `_updateProps` → coalesced __rngpui_setNodeStyle,
//    _getAnimationTimestamp, the frame-callback registry) — imported first so the
//    globals exist before upstream reanimated evaluates,
//  - vsync requestAnimationFrame (this runtime arms frame_clock bit 1),
//  - upstream react-native-reanimated core: its valueSetter drives `sv.value =
//    withSpring(...)` animations HERE, frame by frame, off the React thread,
//  - the worklet runtime in 'ui' role (closure materialization, shared-value
//    slots over __rngpui_svSlots, runOnJS bridging back to the React runtime),
//  - the worklet builtin registry, so closures serialized as {kind:'builtin'}
//    (withSpring, withTiming, scrollTo, …) bind to THIS runtime's implementations.
import './seam'
import '../raf'
import {
  Easing,
  withClamp,
  withDecay,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { dispatchCommand, measure, scrollTo, setGestureState, setNativeProps } from './seam'
import { registerWorkletBuiltin } from './worklet-runtime'

// worklets.ts (imported by upstream's react-native-worklets redirect) installs the
// worklet runtime + channel at module load, role-detected from the host fns
// (__rngpui_jsPost ⇒ 'ui'). By the time this body runs, the runtime is live and
// __rngpui_peerRecv is wired; all that's left is populating the builtin registry.

registerWorkletBuiltin('withTiming', withTiming)
registerWorkletBuiltin('withSpring', withSpring)
registerWorkletBuiltin('withDecay', withDecay)
registerWorkletBuiltin('withDelay', withDelay)
registerWorkletBuiltin('withRepeat', withRepeat)
registerWorkletBuiltin('withSequence', withSequence)
registerWorkletBuiltin('withClamp', withClamp)
registerWorkletBuiltin('Easing', Easing)

// upstream's valueSetter (surfaced by the prebuild under an rngpui name): the
// shared-value proxies route writes through it so `sv.value = animation` drives
// the animation HERE — _animation cancel semantics, __frameTimestamp, the
// requestAnimationFrame step loop, per-frame `_value` writes that fan out to
// mapper listeners. without it the proxy's setter throws by design.
import * as upstreamInternals from 'react-native-reanimated'
;(globalThis as Record<string, unknown>).__rngpuiReanimatedValueSetter = (
  upstreamInternals as unknown as Record<string, unknown>
).__rngpuiValueSetter

// the revive table for stamped animation requests shipped by a React-side
// `sv.value = withX(...)` write (reanimated-host.ts stamps; worklets.ts
// HOST_SET_SHARED_VALUE_WORKLET revives by `type` from this global and the
// animation drives HERE, off the React thread).
;(globalThis as Record<string, unknown>).__rngpuiReanimatedAnimationFactories = {
  withTiming,
  withSpring,
  withDecay,
  withDelay,
  withRepeat,
  withSequence,
  withClamp,
}
registerWorkletBuiltin('scrollTo', scrollTo)
registerWorkletBuiltin('measure', measure)
registerWorkletBuiltin('setNativeProps', setNativeProps)
registerWorkletBuiltin('dispatchCommand', dispatchCommand)
registerWorkletBuiltin('setGestureState', setGestureState)

// readiness beacon for conformance probes (RNGPUI_UI_TRACE) — proves this bundle
// evaluated on the worklet runtime, not the React one.
;(globalThis as { __rngpuiUiRuntimeReady?: boolean }).__rngpuiUiRuntimeReady = true
if (typeof process !== 'undefined' && process.env?.RNGPUI_UI_TRACE) {
  console.error('[ui-runtime] ready (worklet runtime evaluated)')
}
