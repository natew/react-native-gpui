// react-native-worklets — the cross-runtime surface for the gpui Hermes target.
//
// port of soot's react-native-worklets stub
// (packages/compat/src/stubs/react-native-worklets-pkg/index.ts) onto rngpui's
// existing export surface. the bundler redirect maps every
// `react-native-worklets` import onto this module, so every export the previous
// single-runtime stub had MUST continue to exist (the export surface is a contract).
//
// ARCHITECTURE (see plans/off-thread-reanimated.md): rngpui runs TWO Hermes
// runtimes — the React runtime (role 'react') and the UI runtime (role 'ui') — that
// cross only as JSON strings through rust host fns, with shared-value primitives in
// a shared ArrayBuffer (`globalThis.__rngpui_svSlots`). on the React runtime, with
// the host bridge present (`typeof __rngpui_uiPost === 'function'`), workletized
// runOnUI / scheduleOnUI / runOnUIAsync DISPATCH to the UI runtime via the worklet
// runtime. SharedValues mirror through the shared slots so UI-side mappers and
// animation clocks mutate the same values. runOnJS-tagged callbacks round-trip back
// to the React runtime.
//
// WITHOUT the bridge (bun unit tests, early bundle eval, headless harnesses): every
// function degrades to LOCAL execution — the previous identity-passthrough behavior
// — because `runtime()` returns null and `shouldUseRemoteUIRuntime()` is false. the
// existing unit tests stay green unchanged.

// Force the reanimated native seam to evaluate (and install `__reanimatedModuleProxy`,
// `global._updateProps`, `__RUNTIME_KIND`, the version shims, the frame-callback
// registry). react-native-worklets is ALWAYS imported by reanimated before its
// NativeReanimated constructor runs, and reanimated's own seam import can be
// tree-shaken when the turbomodule path is dead, so this is the reliable install
// point. the seam's globals must exist before the first `withSpring(...)` evaluates,
// AND before we install the worklet runtime below (the runtime reads __RUNTIME_KIND-
// adjacent globals). keep this import FIRST.
import './seam'

import {
  installWorkletRuntime,
  markObjectSV,
  type WorkletRuntime as WorkletRuntimeInstance,
  type WorkletRuntimeRole,
} from './worklet-runtime'
import { installChannel, makeChannel } from './worklet-channel'

// =============================================================================
// types
// =============================================================================

export interface WorkletFunction {
  __workletHash?: number
  __initData?: { code?: string; location?: string; sourceMap?: string }
  __closure?: Record<string, unknown>
  (...args: unknown[]): unknown
}

export interface SerializableRef {
  __init?: () => unknown
}

export interface Synchronizable<T> {
  getBlocking(): T
  setBlocking(value: T): void
}

export interface IWorkletsModule {
  makeShareableClone: (value: unknown) => unknown
  scheduleOnUI: (fn: () => void) => void
  executeOnUIRuntimeSync: <T extends (...args: unknown[]) => unknown>(fn: T) => T
  createWorkletRuntime: (name: string, initializer?: () => void) => unknown
}

export type MakeShareableClone = (value: unknown) => unknown
export type WorkletRuntime = unknown

// =============================================================================
// runtime kind — the React runtime claims UI (2) so reanimated v4's runtimeKind
// branches take the UI path (animations actually run, setNativeProps executes,
// cancelAnimation writes the SV directly). The seam installs __RUNTIME_KIND=2; the
// guards below read it live.
// =============================================================================

export enum RuntimeKind {
  ReactNative = 1,
  UI = 2,
  Worker = 3,
}

const RNGPUI_UI_RUNTIME_HOLDER = { __rngpui_ui_runtime: true }
const RNGPUI_UI_SCHEDULER_HOLDER = { __rngpui_ui_scheduler: true }

export function getUIRuntimeHolder(): object {
  return RNGPUI_UI_RUNTIME_HOLDER
}

export function getUISchedulerHolder(): object {
  return RNGPUI_UI_SCHEDULER_HOLDER
}

export const UIRuntimeId = 1

// =============================================================================
// runtime install — wire the per-runtime WorkletRuntime + channel at module load,
// role auto-detected from which rust host post-fn is present in THIS runtime:
//   - __rngpui_uiPost present  ⇒ we are the React runtime  ⇒ role 'react' (the
//     bundler redirects this stub onto the app bundle = React runtime, but the UI
//     bundle's ui-entry.ts also imports the worklets redirect, so this code runs on
//     both — detect, don't assume).
//   - __rngpui_jsPost present (and not __rngpui_uiPost) ⇒ role 'ui'.
// Without either host fn (bun unit tests, early bundle eval): no runtime installs
// and every path stays local exactly as the previous single-runtime stub did.
//
// `runtime()` reads the installed singleton off globalThis (so the runtime module
// and this stub agree without a cross-import cycle for resolution).
// =============================================================================

function detectRole(): WorkletRuntimeRole | null {
  const g = globalThis as { __rngpui_uiPost?: unknown; __rngpui_jsPost?: unknown }
  if (typeof g.__rngpui_uiPost === 'function') return 'react'
  if (typeof g.__rngpui_jsPost === 'function') return 'ui'
  return null
}

// shouldUseRemoteUIRuntime: in rngpui this is exactly "host bridge present AND role
// react" — the React runtime dispatches worklets to the UI runtime; the UI runtime
// runs them locally (it has __rngpui_jsPost but not __rngpui_uiPost). collapses to
// false without the bridge, so every dispatch stays local in bun tests.
function shouldUseRemoteUIRuntime(): boolean {
  return detectRole() === 'react'
}

;(() => {
  const role = detectRole()
  if (!role) return
  const channel = makeChannel(role)
  const rt = installWorkletRuntime({ role, channel })
  if (rt) installChannel(role, rt)
})()

// =============================================================================
// createShareable — wire an upstream-decorated SharedValue across the React↔UI
// shared slots. `mutables.ts` calls `createShareable(UIRuntimeId, initial,
// { hostDecorator, guestDecorator })`; upstream's `mutableHostDecorator` builds the
// full SharedValue surface (value getter/setter, modify, addListener, _animation,
// _isReanimatedSharedValue) around `{value: initial}`.
//
// routing (faithful to soot):
//   1. allocate a shared slot with the initial primitive (object slot for arrays /
//      plain objects)
//   2. let upstream's `mutableHostDecorator` build its full surface
//   3. redirect writes through the slot via the public addListener bridge so the
//      peer sees them (skip-notify on the bounce-back to avoid loops)
//   4. attach `_id = slotId` so serializeValue routes this as {kind:'sv'} and the
//      peer's deserializeValue hands the worklet body a proxy bound to the same slot
//
// Without the runtime (bun tests) the decorated SV still works locally; it just
// won't propagate cross-runtime.
// =============================================================================

interface ShareableGuestBase<TValue = unknown> {
  isHost: false
  __shareableRef: true
  getSync(): TValue
  setAsync(value: TValue | ((prev: TValue) => TValue)): void
  setSync(value: TValue | ((prev: TValue) => TValue)): void
  getAsync(): Promise<TValue>
  modify?(modifier: (value: TValue) => TValue, forceUpdate?: boolean): void
}

interface ShareableConfig<H = unknown, G = unknown> {
  hostDecorator?: (host: { value: unknown }) => H
  guestDecorator?: (guest: ShareableGuestBase) => G
  initSynchronously?: boolean
}

const _RNGPUI_SAB_SUPPRESS_NOTIFY = Symbol('rngpui_sab_suppress_notify')

// keeps the host-decorated SharedValue (its peer-write→`_value` bridge) alive
// exactly as long as the consumer holds the guest surface, so the slot is reclaimed
// when the *consumer's* object dies, not earlier.
const SAB_HOST_TARGET = Symbol('rngpui_sab_host_target')

// reclaim slot ids when a SharedValue's JS wrapper is garbage-collected. real
// reanimated releases the native Shareable when the JS Mutable is collected; this is
// the faithful analog. it is the SOLE caller of rt.freeSlot (exactly once per
// registered wrapper), so there is no free→reuse→stale-finalizer ABA: the slot is
// not on the free-list until this fires, and it fires once.
const sabSlotFinalizer = new FinalizationRegistry<{
  rt: RuntimeShape
  slotId: number
}>(({ rt, slotId }) => {
  try {
    rt.freeSlot(slotId)
  } catch {}
})

// throttle the "createShareable failed; falling back to local-only" warnings. when
// the worklet runtime exhausts its slot pool during a re-render storm,
// createShareable's catch fires for every one of hundreds of thousands of failed
// allocs; an unthrottled console.warn per call floods the console and contributes to
// OOM-ing the runtime. log at most once per window with a suppressed count.
const shareableFallbackThrottle = { lastAt: 0, suppressed: 0 }
function warnShareableFallback(label: string, err: unknown): void {
  shareableFallbackThrottle.suppressed++
  const now = Date.now()
  if (now - shareableFallbackThrottle.lastAt <= 2000) return
  console.warn(
    `[rngpui-sab] ${label}; falling back to local-only (+${shareableFallbackThrottle.suppressed} suppressed):`,
    err,
  )
  shareableFallbackThrottle.lastAt = now
  shareableFallbackThrottle.suppressed = 0
}
const RNGPUI_REANIMATED_ANIMATION_DESCRIPTOR = Symbol.for('rngpui.reanimatedAnimationDescriptor')
const RNGPUI_GESTURE_EVENT_TIMESTAMP = Symbol.for('rngpui.gestureEventTimestamp')
const RNGPUI_ANIMATION_REQUEST = '__rngpuiReanimatedAnimation'

const HOST_SET_SHARED_VALUE_WORKLET = markSyntheticWorklet(function (
  sharedValue: unknown,
  payload: unknown,
) {
  'worklet'
  function revive(value: unknown): unknown {
    if (
      value &&
      typeof value === 'object' &&
      (value as Record<string, unknown>).__rngpuiReanimatedAnimation === true
    ) {
      const request = value as { type?: unknown; args?: unknown[] }
      const factories = (
        globalThis as unknown as {
          __rngpuiReanimatedAnimationFactories?: Record<string, (...args: unknown[]) => unknown>
        }
      ).__rngpuiReanimatedAnimationFactories
      const factory = typeof request.type === 'string' ? factories?.[request.type] : null
      if (typeof factory !== 'function') {
        throw new Error(`[rngpui worklets] missing animation factory ${request.type}`)
      }
      return factory(...(Array.isArray(request.args) ? request.args.map(revive) : []))
    }
    if (Array.isArray(value)) return value.map(revive)
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(value as Record<string, unknown>)) {
        out[key] = revive((value as Record<string, unknown>)[key])
      }
      return out
    }
    return value
  }
  ;(sharedValue as { value: unknown }).value = revive(payload)
},
0x50071,
// explicit source (NOT toString — the app bundle is Hermes bytecode): the exact
// JS equivalent of the function above, evaluated on the UI runtime. keep in sync.
`function (sharedValue, payload) {
  function revive(value) {
    if (value && typeof value === 'object' && value.__rngpuiReanimatedAnimation === true) {
      var factories = globalThis.__rngpuiReanimatedAnimationFactories
      var factory = typeof value.type === 'string' && factories ? factories[value.type] : null
      if (typeof factory !== 'function') {
        throw new Error('[rngpui worklets] missing animation factory ' + value.type)
      }
      var args = Array.isArray(value.args) ? value.args.map(revive) : []
      return factory.apply(null, args)
    }
    if (Array.isArray(value)) return value.map(revive)
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      var out = {}
      for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = revive(value[key])
      }
      return out
    }
    return value
  }
  sharedValue.value = revive(payload)
}`)

function getSabRuntime(): RuntimeShape | null {
  return runtime()
}

function isSabBackable(value: unknown): value is number | boolean {
  return typeof value === 'number' || typeof value === 'boolean'
}

function valueToFloat(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  return Number.NaN
}

function markSyntheticWorklet<T extends (...args: unknown[]) => unknown>(
  fn: T,
  hash: number,
  code?: string,
): T & WorkletFunction {
  const worklet = fn as T & WorkletFunction
  Object.defineProperty(worklet, '__workletHash', {
    value: hash,
    enumerable: false,
    configurable: true,
    writable: false,
  })
  Object.defineProperty(worklet, '__initData', {
    // CAREFUL: fn.toString() is only valid source when the bundle ships source.
    // In a Hermes BYTECODE bundle (app.hbc) toString() returns "{ [bytecode] }",
    // which evals to garbage on the peer runtime — any synthetic worklet whose
    // code actually CROSSES must pass an explicit `code` string.
    value: { code: code ?? fn.toString() },
    enumerable: false,
    configurable: true,
    writable: false,
  })
  Object.defineProperty(worklet, '__closure', {
    value: {},
    enumerable: false,
    configurable: true,
    writable: true,
  })
  return worklet
}

export function createShareable<TValue, THostDecorated = unknown, TGuestDecorated = unknown>(
  _hostRuntimeId: number,
  initial: TValue,
  config?: ShareableConfig<THostDecorated, TGuestDecorated>,
): unknown {
  // legacy single-arg form (`createShareable(value)`) — passthrough.
  if (config === undefined && typeof _hostRuntimeId !== 'number') {
    return _hostRuntimeId
  }

  const base: { value: TValue } = { value: initial }
  // upstream wraps `hostDecorator` with the babel-worklets transform, which reads
  // captured variables via `this.__closure`. invoking it locally requires `this` to
  // be the function itself — same convention the worklet runtime uses inside
  // handleRunWorklet (`fn.apply(fn, args)`).
  const decorated = config?.hostDecorator
    ? config.hostDecorator.call(config.hostDecorator, base)
    : base

  // object SVs (arrays, plain objects) route through the parallel object-slot path:
  // each runtime keeps a Map<id, value> and updates ship as svUpdateBatch
  // objectUpdates.
  if (!isSabBackable(initial)) {
    try {
      const rt = getSabRuntime()
      if (!rt) return decorated
      const host = wireObjectSharedValue(rt, decorated, initial)
      if (shouldUseRemoteUIRuntime() && config?.guestDecorator && hasSharedValueId(host)) {
        const slotId = host._id
        const guest = createGuestSharedValue(rt, slotId, 'object', false, config.guestDecorator)
        Object.defineProperty(guest as object, SAB_HOST_TARGET, {
          value: host,
          enumerable: false,
          configurable: true,
          writable: false,
        })
        sabSlotFinalizer.register(guest as object, { rt, slotId })
        return guest
      }
      if (hasSharedValueId(host)) {
        sabSlotFinalizer.register(host as object, { rt, slotId: host._id })
      }
      return host
    } catch (err) {
      warnShareableFallback('object createShareable failed', err)
      return decorated
    }
  }

  try {
    const rt = getSabRuntime()
    if (!rt) {
      // worklet runtime not yet wired (test contexts without the host bridge). the
      // decorated SV still works locally, it just won't propagate cross-runtime.
      return decorated
    }

    const isBool = typeof initial === 'boolean'
    // tell the runtime this slot holds a boolean so worklet-side proxy reads restore
    // the boolean type (Float64 0/1 → false/true), matching upstream.
    const slotId = rt.allocSharedValueSlot(valueToFloat(initial), isBool)

    const target = decorated as unknown as {
      addListener?: (id: number, listener: (v: unknown) => void) => void
      _value?: unknown
      [k: symbol]: boolean | undefined
    }

    // upstream's `_value` is defined non-configurable, so we can't override it.
    // instead use the public `addListener(id, fn)` surface to inject a sync listener
    // that bounces every settled write into the slot. this catches both
    // animation-frame writes (valueSetter → _value = animation.current) and direct
    // `.value =` assignments (which route through valueSetter → _value =).
    //
    // the suppression flag prevents the peer-notify roundtrip from looping: when a
    // peer write arrives, we replay it through `_value =` to fire upstream's local
    // listeners (mappers, observers); that fires our sync listener too, but
    // suppression is set so it skips the write back.
    //
    // we use `syncToPeer` (not `writeSlot`) so the sync listener does NOT fire the
    // runtime's local subscribers — the upstream `_value` listeners already fired the
    // fan-out for this local write. firing the runtime subscribers here would recurse
    // back into upstream's `_value` setter and double the upstream listener work for
    // every local write.
    const SAB_SYNC_LISTENER_ID = -(slotId * 2 + 1)
    if (typeof target.addListener === 'function') {
      target.addListener(SAB_SYNC_LISTENER_ID, (newValue: unknown) => {
        if (target[_RNGPUI_SAB_SUPPRESS_NOTIFY]) return
        rt.syncToPeer(slotId, valueToFloat(newValue))
      })
    }

    // peer writes route through the upstream `_value` setter to fire the local
    // listener fan-out (mappers included) without going through the animation router
    // on `.value`. the listener holds `target` WEAKLY and re-derives the per-instance
    // setter each call: a strong capture here would pin every SharedValue in the
    // long-lived runtime's `listeners` Map forever (the root slot leak). once the
    // wrapper is GC'd the FinalizationRegistry frees the slot, and the resulting
    // releaseSlotState() drops this now-dead listener.
    const weakTarget = new WeakRef(target as object)
    rt.subscribeSlot(slotId, (next) => {
      const t = weakTarget.deref() as typeof target | undefined
      if (!t) return
      const setter = Object.getOwnPropertyDescriptor(t, '_value')?.set
      if (!setter) return
      t[_RNGPUI_SAB_SUPPRESS_NOTIFY] = true
      try {
        setter.call(t, isBool ? next !== 0 : next)
      } finally {
        t[_RNGPUI_SAB_SUPPRESS_NOTIFY] = false
      }
    })

    // tag with `_id` so the runtime's serializeValue routes this as `{kind:'sv'}` and
    // the peer's deserializeValue hands the worklet body a proxy that reads/writes the
    // same slot.
    Object.defineProperty(target, '_id', {
      value: slotId,
      enumerable: false,
      configurable: true,
      writable: false,
    })

    if (shouldUseRemoteUIRuntime() && config?.guestDecorator) {
      const guest = createGuestSharedValue(rt, slotId, 'primitive', isBool, config.guestDecorator)
      Object.defineProperty(guest as object, SAB_HOST_TARGET, {
        value: target,
        enumerable: false,
        configurable: true,
        writable: false,
      })
      sabSlotFinalizer.register(guest as object, { rt, slotId })
      return guest
    }

    sabSlotFinalizer.register(target as object, { rt, slotId })
    return target as THostDecorated
  } catch (err) {
    warnShareableFallback('createShareable failed', err)
    return decorated
  }
}

function hasSharedValueId(value: unknown): value is { _id: number } {
  return (
    !!value && typeof value === 'object' && typeof (value as { _id?: unknown })._id === 'number'
  )
}

type SharedValueSlotKind = 'primitive' | 'object'

function createGuestSharedValue<TGuestDecorated>(
  rt: RuntimeShape,
  slotId: number,
  kind: SharedValueSlotKind,
  isBool: boolean,
  guestDecorator: (guest: ShareableGuestBase) => TGuestDecorated,
): TGuestDecorated {
  let guestSurface: unknown
  const read = () => {
    if (kind === 'object') return rt.readObjectSlot(slotId)
    const value = rt.readSlot(slotId)
    return isBool ? value !== 0 : value
  }
  // the SAB-plumbing methods must be NON-ENUMERABLE. reanimated's
  // `mutableGuestDecorator` `value` getter calls `mutable.getSync()` and the setter
  // calls `mutable.setAsync()`, so these have to survive for the lifetime of the
  // SharedValue. but consumers iterate the SharedValue with `Object.keys()` — e.g.
  // @gorhom/bottom-sheet's `resetContext` worklet does
  // `Object.keys(context).map(k => context[k] = undefined)`. an enumerable
  // getSync/setAsync would be wiped and `value` access would throw `getSync is not a
  // function`.
  //
  // a plain-value write into the guest SharedValue. the shared slot (and the
  // object-slot Map) is shared memory between the React and UI runtimes, so writing
  // it locally is both (a) immediately visible to a same-frame `getSync()` on this
  // runtime and (b) propagated to the peer via the `svUpdateBatch` flush — which
  // fires the UI-side host SharedValue's listeners (mappers, useAnimatedStyle). this
  // preserves the upstream contract: a worklet that writes `sv.value = x` then
  // synchronously reads it back sees its own write.
  const writeLocalSlot = (value: unknown) => {
    if (kind === 'object') {
      rt.writeObjectSlot(slotId, value)
    } else {
      rt.writeSlot(slotId, valueToFloat(value))
    }
  }
  // route every write through the host runtime ONLY when the payload is (or contains)
  // an animation descriptor — `withTiming`/`withSpring`/… must run their per-frame
  // driver on the reanimated UI runtime. plain values stay synchronous via the shared
  // slot.
  //
  // upstream invariant: ALL writes go through ONE `valueSetter` on ONE UI runtime, and
  // a plain `.value =` write nulls `mutable._animation`, which cancels any running
  // animation (`cancelAnimation` is literally `sv.value = sv.value`). our split runs
  // the animation driver on the UI host but keeps plain writes React-local for
  // same-frame sync read-back — so a plain write would never reach the UI valueSetter
  // and the previous gesture's `onEnd` `withSpring` is never cancelled. mirror the
  // FIRST plain write after an animation to the host valueSetter so its `_animation` is
  // nulled exactly like upstream; keep mirroring until the host setter has actually
  // applied the cancel/reset.
  let hostAnimationPending = false
  let hostPlainSetScheduled = false
  let hostPlainSetPayload: unknown
  let hostPlainSetGeneration = 0
  let hostPlainSetSettledGeneration = 0
  let hostPlainSetInFlight = 0
  const flushHostPlainSet = () => {
    if (!hostPlainSetScheduled) return
    const payload = hostPlainSetPayload
    hostPlainSetScheduled = false
    hostPlainSetPayload = undefined
    const generation = ++hostPlainSetGeneration
    hostPlainSetInFlight++
    void dispatchHostValueSet(rt, guestSurface, payload, true)
      .catch(() => {})
      .finally(() => {
        hostPlainSetInFlight = Math.max(0, hostPlainSetInFlight - 1)
        hostPlainSetSettledGeneration = Math.max(hostPlainSetSettledGeneration, generation)
        if (
          hostPlainSetSettledGeneration >= hostPlainSetGeneration &&
          hostPlainSetInFlight === 0 &&
          !hostPlainSetScheduled
        ) {
          hostAnimationPending = false
        }
      })
  }
  const queueHostPlainSet = (value: unknown) => {
    hostPlainSetPayload = encodeHostValue(value)
    if (hostPlainSetScheduled) return
    hostPlainSetScheduled = true
    queueMicrotask(flushHostPlainSet)
  }
  const resolveSetValue = (value: unknown): unknown => {
    if (
      typeof value === 'function' &&
      (value as unknown as Record<string, unknown>).__isAnimationDefinition !== true
    ) {
      return (value as (current: unknown) => unknown)(read())
    }
    return value
  }
  const setValue = (value: unknown) => {
    const resolved = resolveSetValue(value)
    if (containsAnimationRequest(resolved)) {
      flushHostPlainSet()
      hostAnimationPending = true
      void dispatchHostValueSet(rt, guestSurface, encodeHostValue(resolved), false).catch(() => {})
    } else {
      writeLocalSlot(resolved)
      if (hostAnimationPending) {
        queueHostPlainSet(resolved)
      }
    }
  }
  const guest = {} as ShareableGuestBase
  Object.defineProperties(guest, {
    isHost: { value: false, enumerable: false, configurable: true, writable: true },
    __shareableRef: { value: true, enumerable: false, configurable: true, writable: true },
    getSync: { value: read, enumerable: false, configurable: true, writable: true },
    getAsync: {
      value: () => Promise.resolve(read()),
      enumerable: false,
      configurable: true,
      writable: true,
    },
    setAsync: { value: setValue, enumerable: false, configurable: true, writable: true },
    setSync: { value: setValue, enumerable: false, configurable: true, writable: true },
  })
  guestSurface = guestDecorator.call(guestDecorator, guest)
  Object.defineProperty(guestSurface as object, '_id', {
    value: slotId,
    enumerable: false,
    configurable: true,
    writable: false,
  })
  if (kind === 'object') {
    markObjectSV(guestSurface as object)
  }
  return guestSurface as TGuestDecorated
}

function dispatchHostValueSet(
  rt: RuntimeShape,
  guestSurface: unknown,
  payload: unknown,
  awaitReply: boolean,
): Promise<unknown> {
  return rt
    .dispatchWorklet(HOST_SET_SHARED_VALUE_WORKLET, [guestSurface, payload], { awaitReply })
    .catch((err: unknown) => {
      console.error('[rngpui worklets] shared value host set failed:', err)
      throw err
    })
}

function encodeHostValue(value: unknown): unknown {
  const descriptor = readAnimationDescriptor(value)
  if (descriptor) {
    return {
      [RNGPUI_ANIMATION_REQUEST]: true,
      type: descriptor.type,
      args: descriptor.args.map(encodeHostValue),
    }
  }
  if (Array.isArray(value)) return value.map(encodeHostValue)
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = encodeHostValue((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

// true when `value` is an animation descriptor (`withTiming`/`withSpring`/…) or has
// one nested inside an array / plain object — those must run their per-frame driver
// on the reanimated UI runtime, so the write routes through
// `HOST_SET_SHARED_VALUE_WORKLET`. plain values write the shared slot directly.
function containsAnimationRequest(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (readAnimationDescriptor(value)) return true
  if (Array.isArray(value)) return value.some(containsAnimationRequest)
  if (Object.getPrototypeOf(value) === Object.prototype) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (containsAnimationRequest((value as Record<string, unknown>)[key])) return true
    }
  }
  return false
}

function readAnimationDescriptor(value: unknown): { type: string; args: unknown[] } | null {
  if (!value || typeof value !== 'object') return null
  const descriptor = (value as { [RNGPUI_REANIMATED_ANIMATION_DESCRIPTOR]?: unknown })[
    RNGPUI_REANIMATED_ANIMATION_DESCRIPTOR
  ]
  if (!descriptor || typeof descriptor !== 'object') return null
  const type = (descriptor as { type?: unknown }).type
  const args = (descriptor as { args?: unknown }).args
  if (typeof type !== 'string' || !Array.isArray(args)) return null
  return { type, args }
}

// =============================================================================
// runtime accessor — duck-typed against worklet-runtime.ts. resolved via globalThis
// so the stub and the runtime agree without an import-time resolution cycle.
// =============================================================================

interface RuntimeShape {
  dispatchWorklet(
    fn: WorkletFunction,
    args: unknown[],
    opts?: { awaitReply?: boolean; eventTimestamp?: number },
  ): Promise<unknown>
  registerJSCallback<T extends (...args: unknown[]) => unknown>(fn: T): T
  allocSharedValueSlot(initial: number, isBool?: boolean): number
  readSlot(id: number): number
  writeSlot(id: number, value: number, skipNotify?: boolean): boolean
  syncToPeer(id: number, value: number): boolean
  subscribeSlot(id: number, fn: (value: number) => void): () => void
  allocObjectSharedValueSlot(initial: unknown): number
  readObjectSlot(id: number): unknown
  writeObjectSlot(id: number, value: unknown, skipNotify?: boolean): boolean
  syncObjectToPeer(id: number, value: unknown): boolean
  subscribeObjectSlot(id: number, fn: (value: unknown) => void): () => void
  freeSlot(id: number): void
}

/**
 * Wire an upstream-decorated object-shaped SharedValue (initial is array or plain
 * object) for cross-runtime propagation. Same routing pattern as the primitive path:
 * sync listener bounces local writes to the peer, peer writes route through `_value`
 * setter so upstream listeners (mappers, useDerivedValue) fan out.
 */
function wireObjectSharedValue(rt: RuntimeShape, decorated: unknown, initial: unknown): unknown {
  const slotId = rt.allocObjectSharedValueSlot(initial)

  const target = decorated as unknown as {
    addListener?: (id: number, listener: (v: unknown) => void) => void
    modify?: (modifier: (value: unknown) => unknown, forceUpdate?: boolean) => void
    value?: unknown
    _value?: unknown
    [k: symbol]: boolean | undefined
  }

  const SAB_SYNC_LISTENER_ID = -(slotId * 2 + 1)
  if (typeof target.addListener === 'function') {
    target.addListener(SAB_SYNC_LISTENER_ID, (newValue: unknown) => {
      if (target[_RNGPUI_SAB_SUPPRESS_NOTIFY]) return
      rt.syncObjectToPeer(slotId, newValue)
    })
  }

  const _valueDesc = Object.getOwnPropertyDescriptor(target, '_value')

  const readCurrentValue = () => {
    try {
      if (_valueDesc?.get) return _valueDesc.get.call(target)
    } catch {}
    try {
      return target.value
    } catch {}
    return initial
  }

  // upstream ViewDescriptorsSet.add mutates the descriptor array in place and calls
  // modify(..., false). valueSetter then intentionally skips listener fan-out because
  // the returned array reference is unchanged. on native that mutation happens on the
  // UI runtime where mappers read the same shareable. in rngpui it happens on react,
  // so explicitly mirror object-SV modify results into the UI object slot.
  const originalModify = target.modify
  if (typeof originalModify === 'function') {
    target.modify = (modifier, forceUpdate = true) => {
      originalModify.call(target, modifier, forceUpdate)
      if (!target[_RNGPUI_SAB_SUPPRESS_NOTIFY]) {
        rt.syncObjectToPeer(slotId, readCurrentValue())
      }
    }
  }

  // weak target + re-derived setter, same rationale as the primitive path: a strong
  // capture would pin every object SharedValue in the runtime's objectListeners Map
  // forever. releaseSlotState() (via the FinalizationRegistry) drops this listener
  // once the wrapper is collected.
  const weakObjTarget = new WeakRef(target as object)
  rt.subscribeObjectSlot(slotId, (next) => {
    const t = weakObjTarget.deref() as typeof target | undefined
    if (!t) return
    const setter = Object.getOwnPropertyDescriptor(t, '_value')?.set
    if (!setter) return
    t[_RNGPUI_SAB_SUPPRESS_NOTIFY] = true
    try {
      setter.call(t, next)
    } finally {
      t[_RNGPUI_SAB_SUPPRESS_NOTIFY] = false
    }
  })

  Object.defineProperty(target, '_id', {
    value: slotId,
    enumerable: false,
    configurable: true,
    writable: false,
  })
  // brand so the runtime's serializeValue routes this as kind:'svObject' instead of
  // the slot-backed kind:'sv'.
  markObjectSV(target as object)

  return target
}

function runtime(): RuntimeShape | null {
  const r = (globalThis as { __rngpui_worklet_runtime?: RuntimeShape }).__rngpui_worklet_runtime
  return r ?? null
}

function isWorkletFn(fn: unknown): fn is WorkletFunction {
  if (typeof fn !== 'function') return false
  const f = fn as WorkletFunction
  return typeof f.__workletHash === 'number' && typeof f.__initData?.code === 'string'
}

// =============================================================================
// core dispatchers
// =============================================================================

/**
 * In real reanimated, runOnJS schedules `fn` on the JS runtime. On rngpui the React
 * runtime IS the JS runtime, so the wrapper executes locally — the worklet runtime
 * registers the wrapper so that when it's captured in a closure that later ships to
 * the UI runtime, the UI-side proxy routes call-args back here. Without the runtime,
 * identity.
 */
export function runOnJS<T extends (...args: unknown[]) => unknown>(fn: T): T {
  const rt = runtime()
  if (!rt) return fn
  return rt.registerJSCallback(fn)
}

/**
 * `runOnUI(fn)` returns a wrapper that schedules workletized functions on the UI
 * runtime; the UI runtime itself runs them on its local microtask path.
 */
export function runOnUI<T extends (...args: unknown[]) => unknown>(fn: T): T {
  const wrapped = ((...args: unknown[]) => {
    scheduleOnUI(fn, ...args)
  }) as unknown as T
  return wrapped
}

/**
 * `runOnRuntime(runtime, fn)` is the explicit cross-runtime escape hatch. rngpui has
 * one peer runtime (the UI runtime); this routes through the worklet runtime when
 * available so callers that genuinely need off-thread execution still get it.
 * Degrades to local execution when no peer is wired.
 */
export function runOnRuntime<T extends (...args: unknown[]) => unknown>(
  _runtime: unknown,
  fn: T,
): T {
  const wrapped = ((...args: unknown[]) => {
    const rt = runtime()
    if (!rt || !isWorkletFn(fn)) return (fn as (...a: unknown[]) => unknown).apply(fn, args)
    return rt.dispatchWorklet(fn as unknown as WorkletFunction, args, { awaitReply: false })
  }) as unknown as T
  return wrapped
}

/** Real signature: scheduleOnRN(fn, ...args) — calls fn(...args) async. */
export function scheduleOnRN<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ...args: unknown[]
): void {
  if (typeof fn !== 'function') return
  const scheduledArgs = args.map(cloneScheduledValue)
  // we ARE the RN runtime (react). just queue locally.
  queueMicrotask(() => {
    try {
      fn.apply(null, scheduledArgs)
    } catch (err) {
      console.error('[rngpui worklets] scheduleOnRN threw:', err)
    }
  })
}

function cloneScheduledValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneScheduledValue)
  if (!value || typeof value !== 'object') return value
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      cloneScheduledValue(item),
    ]),
  )
}

/**
 * `scheduleOnUI(fn, ...args)` — real iOS schedules `fn` on the UI runtime. rngpui's
 * UI runtime is the second Hermes runtime, so workletized callbacks dispatch there
 * from the React runtime. plain callbacks (not serializable worklets) and the no-
 * bridge path keep the local microtask behavior.
 */
export function scheduleOnUI<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ...args: unknown[]
): void {
  const rt = runtime()
  const isWorklet = isWorkletFn(fn)
  const dispatchToShell = shouldUseRemoteUIRuntime() && !!rt && isWorklet
  if (dispatchToShell) {
    rt.dispatchWorklet(fn as unknown as WorkletFunction, args, { awaitReply: false }).catch(
      (err: unknown) => {
        console.error('[rngpui worklets] scheduleOnUI dispatch failed:', err)
      },
    )
    return
  }
  queueMicrotask(() => {
    try {
      // call with fn as `this` so the babel-emitted `this.__closure.X` references
      // resolve, same convention as the worklet runtime.
      ;(fn as { _recur?: unknown })._recur = fn
      fn.apply(fn, args)
    } catch (err) {
      console.error('[rngpui worklets] scheduleOnUI local threw:', err)
    }
  })
}

/**
 * Invoke a GestureDetector lifecycle callback respecting RN's worklet / non-worklet
 * runtime split. a callback that IS a worklet runs on the UI runtime — the same
 * runtime as the `useAnimatedStyle` mapper and the `withTiming`/`withSpring` driver —
 * so a shared value's `valueSetter` animation lifecycle stays coherent.
 *
 * the `gesture` carries RNGH's `runOnJS` flag. a callback is dispatched to the UI
 * runtime ONLY when it is a worklet AND the gesture did not opt into `runOnJS(true)`.
 * a `runOnJS(true)` gesture (e.g. tamagui's press gesture, whose onBegin/onEnd are
 * babel-workletized yet mutate React state) must run on the React runtime. a
 * non-worklet callback — and every callback when the bridge is absent — runs
 * synchronously on the React runtime as before.
 */
export function invokeGestureCallback(
  // biome-ignore lint/suspicious/noExplicitAny: gesture callbacks carry event-specific payloads
  cb: ((...a: any[]) => unknown) | null | undefined,
  gesture: { _runOnJS?: boolean } | null | undefined,
  ...args: unknown[]
): void {
  if (typeof cb !== 'function') return
  const rt = runtime()
  const runOnJSFlag = gesture?._runOnJS === true
  const eventTimestamp =
    args[0] &&
    typeof args[0] === 'object' &&
    typeof (args[0] as Record<symbol, unknown>)[RNGPUI_GESTURE_EVENT_TIMESTAMP] === 'number'
      ? ((args[0] as Record<symbol, unknown>)[RNGPUI_GESTURE_EVENT_TIMESTAMP] as number)
      : undefined
  if (rt && shouldUseRemoteUIRuntime() && isWorkletFn(cb) && !runOnJSFlag) {
    const dispatchOpts: { awaitReply: false; eventTimestamp?: number } = { awaitReply: false }
    if (typeof eventTimestamp === 'number') {
      dispatchOpts.eventTimestamp = eventTimestamp
    }
    rt.dispatchWorklet(cb as unknown as WorkletFunction, args, dispatchOpts).catch(
      (err: unknown) => {
        console.error('[rngpui rngh] gesture callback dispatch failed:', err)
      },
    )
    return
  }
  ;(cb as { _recur?: unknown })._recur = cb
  cb.apply(cb, args)
}

/**
 * Sync UI execution is not feasible across runtimes (a blocking wait on the React
 * runtime would freeze the bundle). Best-effort: identity. Upstream only uses
 * executeOnUIRuntimeSync for init-time reads — apps that genuinely need synchronous
 * UI-runtime semantics will see local/stale state, which is acceptable for those
 * bootstrap reads.
 */
export function executeOnUIRuntimeSync<T extends (...args: unknown[]) => unknown>(fn: T): T {
  return fn
}

/** Sync runOnUI — runs LOCALLY on the React runtime. cross-runtime sync is impossible;
 * upstream only uses this for init-time reads. set `this = fn` so the babel-emitted
 * `this.__closure.X` and `this._recur` references inside worklet bodies resolve. */
export function runOnUISync<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ...args: unknown[]
): unknown {
  ;(fn as { _recur?: unknown })._recur = fn
  return fn.apply(fn, args)
}

// runOnUIAsync awaits the dispatch result.
export function runOnUIAsync<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ...args: unknown[]
): Promise<unknown> {
  const rt = runtime()
  if (!rt || !isWorkletFn(fn) || !shouldUseRemoteUIRuntime()) {
    return Promise.resolve(fn.apply(fn, args))
  }
  return rt.dispatchWorklet(fn as unknown as WorkletFunction, args, { awaitReply: true })
}

// =============================================================================
// shareables — rngpui shares state via the slot-backed SharedValue layer when
// applicable; the rest of these are identity matching the previous stub contract.
// =============================================================================

// stable across the React realm; the runtime serializer reads the same Symbol.for
// key to emit a `shareableRef` instead of a deep snapshot, so a re-shipped shareable
// resolves to the SAME persistent UI-side object (upstream `serializableMappingCache`
// contract). without the stamp the serializer deep-clones reanimated's `remoteState`
// on every stopMapper/startMapper, breaking 2nd-animation spring continuity.
const SHAREABLE_ID_KEY = Symbol.for('rngpui.shareableId')
let nextShareableId = 1

export function makeShareable<T>(value: T): T {
  // identity on the home (react) runtime — matches upstream, where the shareable on
  // its home runtime is just the object. only stamp plain mutable records (reanimated
  // `remoteState`, scroll-handler state); leave primitives / SharedValues / functions
  // / frozen objects untouched.
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype &&
    !Object.isFrozen(value)
  ) {
    const rec = value as Record<symbol, unknown>
    if (typeof rec[SHAREABLE_ID_KEY] !== 'number') {
      try {
        Object.defineProperty(value, SHAREABLE_ID_KEY, {
          value: nextShareableId++,
          enumerable: false,
          writable: false,
          configurable: false,
        })
      } catch {
        // sealed between check and define — fall back to identity (the deep-snapshot
        // path; no continuity, but no crash).
      }
    }
  }
  return value
}

export function createSerializable(config: { __init?: () => unknown }): unknown {
  return config
}

export function createSynchronizable<T>(initial: T): Synchronizable<T> {
  let value = initial
  return {
    getBlocking() {
      return value
    },
    setBlocking(v: T) {
      value = v
    },
  }
}

const SERIALIZABLE_MAPPING_CACHE = Symbol.for('rngpui.serializableMappingCache')
export const serializableMappingCache = ((
  globalThis as Record<symbol, WeakMap<object, unknown> | undefined>
)[SERIALIZABLE_MAPPING_CACHE] ??= new WeakMap<object, unknown>())

// =============================================================================
// worklet introspection — polyfill __closure/__workletHash on demand so upstream's
// areWorkletsEqual (useHandler/useEvent) never throws on a not-yet-transformed fn.
// =============================================================================

export function isWorkletFunction(fn: unknown): fn is WorkletFunction {
  if (typeof fn !== 'function') return false
  const f = fn as WorkletFunction
  if (f.__closure === undefined) {
    try {
      Object.defineProperty(f, '__closure', { value: {}, writable: true, configurable: true })
    } catch {}
  }
  if (f.__workletHash === undefined) {
    try {
      Object.defineProperty(f, '__workletHash', { value: 0, writable: true, configurable: true })
    } catch {}
  }
  return true
}

export function createWorkletRuntime(name: string, _initializer?: () => void): unknown {
  return { name }
}

export function callMicrotasks(): void {
  // host js engine drains microtasks after each loop tick.
}

export const WorkletsModule: IWorkletsModule = {
  makeShareableClone: (value: unknown) => value,
  scheduleOnUI: (fn: () => void) => scheduleOnUI(fn),
  executeOnUIRuntimeSync: (fn) => fn,
  createWorkletRuntime: (name: string) => ({ name }),
}

export function useWorklet<T>(fn: T, _deps?: unknown[]): T {
  return fn
}

export function createWorklet<T extends (...args: unknown[]) => unknown>(fn: T): T {
  return fn
}

export class WorkletRuntimeClass {
  name: string
  constructor(name = 'default') {
    this.name = name
  }
  run<T>(fn: () => T): T {
    return fn()
  }
  destroy(): void {}
}

export const Worklets = {
  defaultContext: { name: 'default' },
  createContext(name = 'default') {
    return { name }
  },
  createRuntime(name = 'default', _initializer?: () => void) {
    return new WorkletRuntimeClass(name)
  },
  createSharedValue<T>(initial: T) {
    return { value: initial }
  },
}

export function currentContext() {
  return Worklets.defaultContext
}

export const shareableMappingCache = serializableMappingCache
export function makeShareableCloneRecursive(value: unknown) {
  return value
}
export function makeShareableCloneOnUIRecursive(value: unknown) {
  return value
}
export function isShareableRef(_value: unknown): boolean {
  return false
}
export const isSerializableRef = isShareableRef

// =============================================================================
// runtime-kind type guards — the React runtime claims UI (2) via the seam's
// __RUNTIME_KIND=2, so isUIRuntime/isWorkletRuntime are true and isRNRuntime is
// false. Upstream gates the runOnUI hop on these; reporting UI keeps reanimated's
// hook/component layer on the eager path while runOnUI still dispatches to the real
// UI runtime when the bridge is present. Read the live global so the guards stay
// honest if the kind ever changes.
// =============================================================================

export function getRuntimeKind(): RuntimeKind {
  const kind = (globalThis as { __RUNTIME_KIND?: number }).__RUNTIME_KIND
  return kind === RuntimeKind.ReactNative || kind === RuntimeKind.Worker ? kind : RuntimeKind.UI
}

export function scheduleOnRuntime(_runtime: unknown, fn: WorkletFunction, ...args: unknown[]) {
  scheduleOnUI(fn, ...args)
}

export function isRNRuntime(): boolean {
  return getRuntimeKind() === RuntimeKind.ReactNative
}

export function isUIRuntime(): boolean {
  return getRuntimeKind() === RuntimeKind.UI
}

export function isWorkerRuntime(): boolean {
  return getRuntimeKind() === RuntimeKind.Worker
}

export function isWorkletRuntime(): boolean {
  return getRuntimeKind() !== RuntimeKind.ReactNative
}

export function runOnRuntimeAsync<T extends (...args: unknown[]) => unknown>(
  runtime: unknown,
  fn: T,
): T {
  return runOnRuntime(runtime, fn)
}

export function runOnRuntimeSyncWithId<T extends (...args: unknown[]) => unknown>(
  _runtimeId: number,
  fn: T,
  ...args: unknown[]
): unknown {
  return runOnUISync(fn, ...args)
}

export function scheduleOnRuntimeWithId(
  _runtimeId: number,
  fn: WorkletFunction,
  ...args: unknown[]
): void {
  scheduleOnUI(fn, ...args)
}

export function isShareable(value: unknown): boolean {
  if (value == null || typeof value !== 'object') return false
  const v = value as { __isShareable?: boolean; _isReanimatedSharedValue?: boolean }
  return Boolean(v.__isShareable || v._isReanimatedSharedValue)
}

export function isSynchronizable(value: unknown): boolean {
  if (value == null || typeof value !== 'object') return false
  const v = value as { __isSynchronizable?: boolean; addListener?: unknown; removeListener?: unknown }
  if (v.__isSynchronizable) return true
  return typeof v.addListener === 'function' && typeof v.removeListener === 'function'
}

const _customSerializables: Array<{ klass: unknown; serializer: unknown }> = []
export function registerCustomSerializable(klass: unknown, serializer: unknown): void {
  _customSerializables.push({ klass, serializer })
}

export function getStaticFeatureFlag(_name: string): boolean {
  return false
}
export function getDynamicFeatureFlag(_name: string): boolean {
  return false
}
export function setDynamicFeatureFlag(_name: string, _value: boolean): void {}

export default {
  runOnJS,
  runOnUI,
  runOnRuntime,
  scheduleOnRN,
  scheduleOnUI,
  makeShareable,
  createSerializable,
  createSynchronizable,
  serializableMappingCache,
  isWorkletFunction,
  executeOnUIRuntimeSync,
  createWorkletRuntime,
  callMicrotasks,
  WorkletsModule,
  RuntimeKind,
  useWorklet,
  createWorklet,
  WorkletRuntime: WorkletRuntimeClass,
  Worklets,
  currentContext,
}

// install `globalThis.__workletsModuleProxy` so reanimated's NativeWorklets
// constructor doesn't throw "Native part of Worklets doesn't seem to be initialized"
// before the bundle finishes evaluating. Identity-shaped serializables + local/
// dispatched scheduling — there is one worklet execution path (this module) for
// mappers, useAnimatedStyle, _updateProps.
;(() => {
  const g = globalThis as Record<string, unknown> & { __workletsModuleProxy?: unknown }
  if (g.__workletsModuleProxy !== undefined) return
  const wrapAsSerializable = (value: unknown) => ({ __init: () => value })
  const proxy = {
    makeShareableClone: (value: unknown) => value,
    makeShareableCloneOnUI: (value: unknown) => value,
    createSerializable: (value: unknown) => wrapAsSerializable(value),
    createSerializableImport: () => wrapAsSerializable(undefined),
    createSerializableString: (s: string) => wrapAsSerializable(s),
    createSerializableNumber: (n: number) => wrapAsSerializable(n),
    createSerializableBoolean: (b: boolean) => wrapAsSerializable(b),
    createSerializableBigInt: (b: bigint) => wrapAsSerializable(b),
    createSerializableUndefined: () => wrapAsSerializable(undefined),
    createSerializableNull: () => wrapAsSerializable(null),
    createSerializableTurboModuleLike: (props: object) => wrapAsSerializable(props),
    createSerializableObject: (obj: object) => wrapAsSerializable(obj),
    createSerializableHostObject: (obj: object) => wrapAsSerializable(obj),
    createSerializableArray: (arr: unknown[]) => wrapAsSerializable(arr),
    createSerializableMap: (keys: unknown[], values: unknown[]) =>
      wrapAsSerializable(new Map(keys.map((k, i) => [k, values[i]]))),
    createSerializableSet: (values: unknown[]) => wrapAsSerializable(new Set(values)),
    createSerializableInitializer: (obj: object) => wrapAsSerializable(obj),
    createSerializableFunction: (fn: (...a: unknown[]) => unknown) => wrapAsSerializable(fn),
    createSerializableWorklet: (worklet: object) => wrapAsSerializable(worklet),
    createCustomSerializable: (data: unknown) => data,
    registerCustomSerializable: () => {},
    createShareable: (_hostRuntimeId: number, initial: unknown) => wrapAsSerializable(initial),
    scheduleOnUI: (serializable: { __init?: () => unknown }) => {
      const fn = serializable?.__init?.()
      if (typeof fn === 'function') scheduleOnUI(fn as (...args: unknown[]) => unknown)
    },
    runOnUISync: (worklet: { __init?: () => unknown }) => worklet?.__init?.(),
    createWorkletRuntime: (name: string) => ({ name }),
    scheduleOnRuntime: () => {},
    scheduleOnRuntimeWithId: () => {},
    runOnRuntimeSync: () => undefined,
    runOnRuntimeSyncWithId: () => undefined,
    createSynchronizable: (value: unknown) => ({ value, __init: () => value }),
    synchronizableGetDirty: (ref: { value?: unknown }) => ref?.value,
    synchronizableGetBlocking: (ref: { value?: unknown }) => ref?.value,
    synchronizableSetBlocking: (ref: { value?: unknown }, next: unknown) => {
      if (ref) ref.value = next
    },
    synchronizableLock: () => {},
    synchronizableUnlock: () => {},
    reportFatalErrorOnJS: (msg: string, stack: string) => {
      console.error('[reanimated worklet]', msg, stack)
    },
    getStaticFeatureFlag: () => false,
    setDynamicFeatureFlag: () => {},
    getUIRuntimeHolder: () => RNGPUI_UI_RUNTIME_HOLDER,
    getUISchedulerHolder: () => RNGPUI_UI_SCHEDULER_HOLDER,
  }
  Object.defineProperty(g, '__workletsModuleProxy', {
    value: proxy,
    writable: true,
    enumerable: false,
    configurable: true,
  })
  // reanimated v4 branches heavily on __RUNTIME_KIND. claim UI (2) — see the seam.
  ;(g as { __RUNTIME_KIND?: number }).__RUNTIME_KIND = RuntimeKind.UI
})()

// lazy object-shareable wirer for the worklet-runtime serializer.
//
// createShareable's object branch wires a SharedValue EAGERLY (allocates an object
// slot, attaches `_id` + the OBJECT_SV_BRAND, installs the peer-sync listeners). when
// that eager wiring can't run — the slot pool is exhausted under churn or the runtime
// isn't wired yet — it falls back to the local-only `decorated` mutable, which has NO
// `_id`. if such a mutable is later captured in a worklet closure and shipped to the
// UI runtime, the serializer would deep-clone it into a plain object whose peer-side
// `.get()` is missing → tamagui's animatedStyle worklet throws `configRef.get is not
// a function`.
//
// upstream reanimated never has this gap: a SharedValue is ALWAYS shippable because
// its shareable clone is made LAZILY at ship time (makeShareableCloneRecursive).
// restore that invariant by exposing the SAME wireObjectSharedValue used by
// createShareable so the serializer can wire an unwired mutable on first ship.
;(() => {
  const g = globalThis as Record<string, unknown> & {
    __rngpui_wire_object_shareable?: (value: { value: unknown }) => number | null
  }
  if (typeof g.__rngpui_wire_object_shareable === 'function') return
  g.__rngpui_wire_object_shareable = (value: { value: unknown }): number | null => {
    if (hasSharedValueId(value)) return value._id
    const rt = getSabRuntime()
    if (!rt) return null
    try {
      const host = wireObjectSharedValue(rt, value, value.value)
      return hasSharedValueId(host) ? host._id : null
    } catch (err) {
      warnShareableFallback('lazy object shareable wiring failed', err)
      return null
    }
  }
})()

// reference the imported runtime instance type so the import is not elided; it
// documents the shape `runtime()` duck-types against.
export type { WorkletRuntimeInstance }
