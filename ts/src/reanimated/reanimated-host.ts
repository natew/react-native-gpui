// `react-native-reanimated` entry for rngpui bundles — the bundler plugins alias
// the package here, and `rngpui-reanimated-prebuilt` to the prebuilt upstream
// chunk. Re-exports upstream untouched EXCEPT, on the React runtime with the
// worklet bridge present, the animation factories — the producer half of
// sootsim's guestDecorator (plans/off-thread-reanimated.md):
//
//  - calling `withTiming(...)` / `withSpring(...)` / … stamps the returned
//    animation object with a non-enumerable descriptor {type, args} so a direct
//    `sv.value = withX(...)` write on the React runtime can be re-created and
//    DRIVEN on the worklet/UI runtime (worklets.ts setValue →
//    dispatchHostValueSet → HOST_SET_SHARED_VALUE_WORKLET revive).
//  - each wrapper registers itself as a worklet builtin, so a mapper closure
//    capturing `withSpring` serializes as {kind:'builtin', name:'withSpring'}
//    and binds to the UI runtime's OWN factory over there (registered raw by
//    ui-entry.ts). Without this, closure serialization would ship the wrapper
//    as code and lose the stamp-free UI-side identity.
//
// On the UI runtime (and in bun tests / single-runtime mode) factories pass
// through untouched — animations are created and driven locally there, no stamp
// needed. Explicit named exports win over the `export *` per the ES module
// spec's ambiguity rule, so the wrapped names below shadow the chunk's.
import * as upstream from 'rngpui-reanimated-prebuilt'
import { registerWorkletBuiltin } from './worklet-runtime'

export * from 'rngpui-reanimated-prebuilt'
export { default } from 'rngpui-reanimated-prebuilt'

const RNGPUI_REANIMATED_ANIMATION_DESCRIPTOR = Symbol.for('rngpui.reanimatedAnimationDescriptor')

declare const __rngpui_uiPost: ((arg: string) => void) | undefined

// only the React runtime with a live worklet bridge stamps factories.
const wrapFactories = typeof __rngpui_uiPost === 'function'

type AnimationFactory = (...args: unknown[]) => unknown

function stamped(name: string, factory: unknown): AnimationFactory {
  const fn = factory as AnimationFactory
  if (!wrapFactories || typeof fn !== 'function') return fn
  const wrapper: AnimationFactory = (...args: unknown[]) => {
    const out = fn(...args)
    if (out && (typeof out === 'object' || typeof out === 'function')) {
      Object.defineProperty(out as object, RNGPUI_REANIMATED_ANIMATION_DESCRIPTOR, {
        value: { type: name, args },
        enumerable: false,
        configurable: true,
      })
    }
    return out
  }
  // keep the worklet metadata visible on the wrapper so upstream's
  // areWorkletsEqual/isWorkletFunction checks treat it like the original.
  for (const key of ['__workletHash', '__initData', '__closure', '__isAnimationDefinition']) {
    const value = (fn as unknown as Record<string, unknown>)[key]
    if (value !== undefined) {
      Object.defineProperty(wrapper, key, { value, enumerable: false, configurable: true, writable: true })
    }
  }
  registerWorkletBuiltin(name, wrapper)
  return wrapper
}

export const withTiming = stamped('withTiming', upstream.withTiming)
export const withSpring = stamped('withSpring', upstream.withSpring)
export const withDecay = stamped('withDecay', upstream.withDecay)
export const withDelay = stamped('withDelay', upstream.withDelay)
export const withRepeat = stamped('withRepeat', upstream.withRepeat)
export const withSequence = stamped('withSequence', upstream.withSequence)
export const withClamp = stamped('withClamp', upstream.withClamp)
