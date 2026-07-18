// react-native-reanimated — gpui's NATIVE-SEAM-ONLY override.
//
// react-native-reanimated is mostly pure JS: useSharedValue, useAnimatedStyle,
// useDerivedValue, withTiming/withSpring, createAnimatedComponent, the animation
// drivers — all of it resolves from node_modules unchanged. We replace ONLY the thin
// native seam: the turbomodule (`specs/NativeReanimatedModule`) that installs
// `__reanimatedModuleProxy` + `global._*` functions, and the
// `platformFunctions/{scrollTo,measure,setNativeProps,dispatchCommand,setGestureState}`
// (the redirect aliases in the bundler point upstream's imports here).
//
// The single fast path is `engineUpdateProps`: upstream calls `global._updateProps(ops)`
// every animation frame; we coalesce all ops within one rAF tick into ONE host crossing
// (`__rngpui_setNodeStyle`), which lands in Rust's animated-style overlay and re-renders
// WITHOUT a React re-commit. That is off-thread-style animation: the spring driver and
// the useAnimatedStyle mapper run inline (single Hermes runtime, KIND=UI), and only the
// resulting style deltas cross to native.
//
// CRITICAL ordering: __RUNTIME_KIND=2 and RN$Bridgeless=true MUST be installed before
// reanimated first evaluates, or runtimeKind.ts defaults to ReactNative (1), defineAnimation
// returns the bare animation FUNCTION instead of calling it, and `withSpring(...)` leaks a
// function into a style value → "Invalid value function(){…} for setWidth". installReanimated
// NativeSeam() runs at module load (this file is evaluated by the bundler's seam redirect
// before upstream's core.ts imports resolve).

interface MeasuredDimensions {
  x: number
  y: number
  width: number
  height: number
  pageX: number
  pageY: number
}

interface StyleProps {
  [key: string]: unknown
}

interface SerializableLike {
  __init?: () => unknown
}

type WorkletFn = (...args: unknown[]) => unknown

// =============================================================================
// viewTag → globalId registry. `createAnimatedComponent`'s ref resolves to the
// reconciler's `Instance` (getPublicInstance returns it), whose `.id` IS the
// `globalId` Rust keys on. Animated components register their host id here on mount
// (via the patched reanimated component below) so `_updateProps` can map an operation's
// shadowNodeWrapper/viewTag back to the globalId the overlay writes.
// =============================================================================

const VIEW_TAG_TO_GLOBAL_ID = new Map<number, number>()

/** Resolve an upstream `op.shadowNodeWrapper` / viewTag down to a numeric globalId. */
function resolveGlobalId(target: unknown): number | null {
  if (typeof target === 'function') {
    const resolved = (target as () => unknown)()
    if (resolved !== target) return resolveGlobalId(resolved)
  }
  if (typeof target === 'number') {
    return VIEW_TAG_TO_GLOBAL_ID.get(target) ?? target
  }
  if (target && typeof target === 'object') {
    const candidate = target as {
      __rngpuiGlobalId?: unknown
      id?: unknown
      __nativeTag?: unknown
      _nativeTag?: unknown
      __viewTag?: unknown
      current?: unknown
      getTag?: () => unknown
    }
    if (typeof candidate.__rngpuiGlobalId === 'number') return candidate.__rngpuiGlobalId
    if (typeof candidate.id === 'number') return VIEW_TAG_TO_GLOBAL_ID.get(candidate.id) ?? candidate.id
    const tag = candidate.__viewTag ?? candidate.__nativeTag ?? candidate._nativeTag
    if (typeof tag === 'number') return VIEW_TAG_TO_GLOBAL_ID.get(tag) ?? tag
    if (typeof candidate.getTag === 'function') {
      const got = candidate.getTag()
      if (typeof got === 'number') return VIEW_TAG_TO_GLOBAL_ID.get(got) ?? got
    }
    if (candidate.current != null && candidate.current !== target) {
      return resolveGlobalId(candidate.current)
    }
  }
  return null
}

/** Register a viewTag → globalId mapping for an animated component's lifetime. */
export function registerAnimatedViewTag(viewTag: number, globalId: number): void {
  VIEW_TAG_TO_GLOBAL_ID.set(viewTag, globalId)
}

export function unregisterAnimatedViewTag(viewTag: number): void {
  VIEW_TAG_TO_GLOBAL_ID.delete(viewTag)
}

declare const __rngpui_setNodeStyle: ((json: string) => void) | undefined
declare const __rngpui_scrollTo: ((json: string) => void) | undefined

// =============================================================================
// rAF coalescing. Every `_updateProps` op within one frame accumulates here; we
// flush ONCE per rAF tick, in ONE `__rngpui_setNodeStyle` host call (one cx.notify).
// =============================================================================

const PENDING_OPS = new Map<number, Record<string, unknown>>()
let flushScheduled = false

function scheduleFlush(): void {
  if (flushScheduled) return
  flushScheduled = true
  const raf = (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame
  if (typeof raf === 'function') {
    raf.call(globalThis, flushUpdatedProps)
  } else {
    setTimeout(flushUpdatedProps, 16)
  }
}

function flushUpdatedProps(): void {
  flushScheduled = false
  if (PENDING_OPS.size === 0) return
  const ops: Array<[number, Record<string, unknown>]> = []
  for (const [id, style] of PENDING_OPS) ops.push([id, style])
  PENDING_OPS.clear()
  if (typeof __rngpui_setNodeStyle === 'function') {
    __rngpui_setNodeStyle(JSON.stringify(ops))
  }
}

// =============================================================================
// __reanimatedModuleProxy + `global._*`. Upstream's NativeReanimatedModule installs
// these on real iOS; we wire the equivalents at module load so upstream's core.ts /
// mappers.ts see fully-wired globals by the time they import this seam.
// =============================================================================

let proxyInstalled = false

function installReanimatedNativeSeam(): void {
  if (proxyInstalled) return
  proxyInstalled = true

  const g = globalThis as Record<string, unknown> & {
    global?: typeof globalThis
    _tagToJSPropNamesMapping?: Record<number, Record<string, boolean>>
    _getAnimationTimestamp?: () => number
    _updateProps?: (operations: Array<{ shadowNodeWrapper: unknown; updates: StyleProps }>) => void
    _updatePropsFabric?: (operations: Array<{ shadowNodeWrapper: unknown; updates: StyleProps }>) => void
    _updatePropsPaper?: (operations: Array<{ tag: unknown; name?: unknown; updates: StyleProps }>) => void
    _scrollTo?: (...args: unknown[]) => void
    _scrollToPaper?: (...args: unknown[]) => void
    _measure?: (node: unknown) => MeasuredDimensions | null
    _measureFabric?: (node: unknown) => MeasuredDimensions | null
    _measurePaper?: (node: unknown) => MeasuredDimensions | null
    _dispatchCommand?: (...args: unknown[]) => void
    _dispatchCommandFabric?: (...args: unknown[]) => void
    _dispatchCommandPaper?: (...args: unknown[]) => void
    _scheduleHostFunctionOnJS?: (fn: WorkletFn, args?: unknown[]) => void
    _scheduleRemoteFunctionOnJS?: (fn: WorkletFn, args?: unknown[]) => void
    _setGestureState?: (handlerTag: number, newState: number) => void
    _notifyAboutProgress?: (tag: number, value: unknown) => void
    _notifyAboutEnd?: (tag: number, removeView: boolean) => void
    __reanimatedModuleProxy?: ReanimatedModuleProxy
  }

  // worklet bodies reference Node-style `global`; alias to globalThis so closure
  // bindings resolve in either context.
  if (typeof (globalThis as { global?: unknown }).global === 'undefined') {
    ;(globalThis as { global?: unknown }).global = globalThis
  }

  // version-shim getters/setters: read undefined (passes assertSingleReanimatedInstance)
  // and accept any write (records the active guest version, mirrored to _CPP so
  // checkCppVersion sees a matching native side).
  let activeReanimatedJsVersion: string | undefined
  Object.defineProperty(globalThis, '_REANIMATED_VERSION_JS', {
    get: () => undefined,
    set: (version) => {
      activeReanimatedJsVersion = typeof version === 'string' ? version : activeReanimatedJsVersion
    },
    configurable: true,
    enumerable: false,
  })
  Object.defineProperty(globalThis, '_REANIMATED_VERSION_CPP', {
    get: () => activeReanimatedJsVersion,
    set: (version) => {
      activeReanimatedJsVersion = typeof version === 'string' ? version : activeReanimatedJsVersion
    },
    configurable: true,
    enumerable: false,
  })

  // Reanimated 4 requires the New Architecture; claim Bridgeless/Fabric.
  ;(globalThis as { RN$Bridgeless?: boolean }).RN$Bridgeless ??= true

  // __RUNTIME_KIND — MUST be UI (2) before reanimated evaluates (see header).
  if ((globalThis as { __RUNTIME_KIND?: number }).__RUNTIME_KIND !== 2) {
    ;(globalThis as { __RUNTIME_KIND?: number }).__RUNTIME_KIND = 2
  }

  g._tagToJSPropNamesMapping ??= {}
  g._getAnimationTimestamp ??= () => performance.now()

  // the fast path + the rest of the seam.
  g._updateProps ??= (operations) => engineUpdateProps(operations)
  g._updatePropsFabric ??= (operations) => engineUpdateProps(operations)
  g._updatePropsPaper ??= (operations) =>
    engineUpdateProps(operations.map((op) => ({ shadowNodeWrapper: op.tag, updates: op.updates })))

  // measure / scroll / dispatchCommand — gpui's reconciler owns layout, not the
  // worklet UI runtime; resolve against the live node graph through the host id.
  g._measure ??= (node) => engineMeasure(node)
  g._measureFabric ??= (node) => engineMeasure(node)
  g._measurePaper ??= (node) => engineMeasure(node)
  g._scrollTo ??= (node, x, y) => engineScrollTo(node, x, y)
  g._scrollToPaper ??= (node, x, y) => engineScrollTo(node, x, y)
  g._dispatchCommand ??= () => {}
  g._dispatchCommandFabric ??= () => {}
  g._dispatchCommandPaper ??= () => {}
  g._scheduleHostFunctionOnJS ??= (fn, args = []) => {
    queueMicrotask(() => {
      if (typeof fn === 'function') fn(...args)
    })
  }
  g._scheduleRemoteFunctionOnJS ??= (fn, args = []) => {
    queueMicrotask(() => {
      if (typeof fn === 'function') fn(...args)
    })
  }
  g._setGestureState ??= () => {}
  g._notifyAboutProgress ??= () => {}
  g._notifyAboutEnd ??= () => {}

  ensureFrameCallbackRegistry()

  g.__reanimatedModuleProxy ??= createReanimatedModuleProxy()
}

function engineMeasure(_node: unknown): MeasuredDimensions | null {
  // gpui resolves measure through the reconciler's measureInWindow path, not the
  // worklet UI runtime — Tamagui's animation driver doesn't depend on this. Return
  // null (upstream callers tolerate it) rather than guess a rect.
  return null
}

function engineScrollTo(animatedRef: unknown, x: unknown, y: unknown): void {
  const globalId = resolveGlobalId(animatedRef)
  if (
    globalId == null ||
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof __rngpui_scrollTo !== 'function'
  ) {
    return
  }
  __rngpui_scrollTo(JSON.stringify([globalId, x, y]))
}

// =============================================================================
// IReanimatedModule proxy — upstream delegates ~25 methods to it. Most are no-ops on
// gpui; the live ones are registerEventHandler / subscribeForKeyboardEvents (no-op
// here for now — Tamagui springs don't use them). A permissive Proxy returns a no-op
// for any unknown method so older bundles that call legacy methods don't crash.
// =============================================================================

interface ReanimatedModuleProxy {
  [key: string]: (...args: unknown[]) => unknown
}

function createReanimatedModuleProxy(): ReanimatedModuleProxy {
  const base: Record<string, (...args: unknown[]) => unknown> = {
    configureLayoutAnimationBatch: () => {},
    setShouldAnimateExitingForTag: () => {},
    getStaticFeatureFlag: () => false,
    setDynamicFeatureFlag: () => {},
    registerSensor: () => -1,
    unregisterSensor: () => {},
    registerEventHandler: () => -1,
    unregisterEventHandler: () => {},
    subscribeForKeyboardEvents: () => -1,
    unsubscribeFromKeyboardEvents: () => {},
    getViewProp: (..._args: unknown[]) => {
      const cb = _args[2]
      if (typeof cb === 'function') (cb as (r: unknown) => void)(null)
      return null
    },
    setViewStyle: () => {},
    markNodeAsRemovable: () => {},
    unmarkNodeAsRemovable: () => {},
    registerCSSKeyframes: () => {},
    unregisterCSSKeyframes: () => {},
    applyCSSAnimations: () => {},
    unregisterCSSAnimations: () => {},
    runCSSTransition: () => {},
    unregisterCSSTransition: () => {},
    getSettledUpdates: () => [],
    // legacy v3 methods some bundles call directly on the proxy
    scheduleOnUI: (worklet: unknown) => {
      const fn =
        typeof worklet === 'function'
          ? (worklet as WorkletFn)
          : (worklet as { __init?: () => unknown })?.__init?.()
      if (typeof fn === 'function') {
        queueMicrotask(() => {
          try {
            ;(fn as WorkletFn).apply(fn, [])
          } catch (err) {
            console.error('[rngpui reanimated] scheduleOnUI threw:', err)
          }
        })
      }
    },
    makeShareableClone: (value: unknown) => value,
    makeShareableCloneOnUI: (value: unknown) => value,
    installCoreFunctions: () => {},
    installTurboModule: () => {},
    enableLayoutAnimations: () => {},
  }
  return new Proxy(base as ReanimatedModuleProxy, {
    get(target, prop) {
      const value = (target as Record<PropertyKey, unknown>)[prop as PropertyKey]
      if (value !== undefined) return value
      if (typeof prop === 'string') return () => undefined
      return undefined
    },
  })
}

// =============================================================================
// frame callback registry — upstream useFrameCallback drives off this. A minimal,
// rAF-backed registry (mirrors reanimated's own UI-runtime shape) so useFrameCallback
// works; the loop stops when no callbacks are active (idle → 0fps).
// =============================================================================

interface FrameInfo {
  timestamp: number
  timeSincePreviousFrame: number | null
  timeSinceFirstFrame: number
}

function requestFrame(callback: (timestamp: number) => void): void {
  const raf = (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame
  if (typeof raf === 'function') {
    raf.call(globalThis, callback)
    return
  }
  setTimeout(() => callback(performance.now()), 16)
}

function ensureFrameCallbackRegistry(): void {
  const g = globalThis as typeof globalThis & {
    global?: typeof globalThis
    _frameCallbackRegistry?: unknown
  }
  if (g._frameCallbackRegistry) return

  const registry = {
    frameCallbackRegistry: new Map<number, { callback: (f: FrameInfo) => void; startTime: number | null }>(),
    activeFrameCallbacks: new Set<number>(),
    previousFrameTimestamp: null as number | null,
    nextCallId: 0,
    runCallbacks(callId: number) {
      const loop = (timestamp: number) => {
        if (callId !== this.nextCallId) return
        if (this.previousFrameTimestamp === null) this.previousFrameTimestamp = timestamp
        const delta = timestamp - this.previousFrameTimestamp
        this.activeFrameCallbacks.forEach((callbackId) => {
          const details = this.frameCallbackRegistry.get(callbackId)
          if (!details) return
          if (details.startTime === null) {
            details.startTime = timestamp
            details.callback({ timestamp, timeSincePreviousFrame: null, timeSinceFirstFrame: 0 })
          } else {
            details.callback({
              timestamp,
              timeSincePreviousFrame: delta,
              timeSinceFirstFrame: timestamp - details.startTime,
            })
          }
        })
        if (this.activeFrameCallbacks.size > 0) {
          this.previousFrameTimestamp = timestamp
          requestFrame(loop)
        } else {
          this.previousFrameTimestamp = null
        }
      }
      if (this.activeFrameCallbacks.size === 1 && callId === this.nextCallId) requestFrame(loop)
    },
    registerFrameCallback(callback: (f: FrameInfo) => void, callbackId: number) {
      this.frameCallbackRegistry.set(callbackId, { callback, startTime: null })
    },
    unregisterFrameCallback(callbackId: number) {
      this.manageStateFrameCallback(callbackId, false)
      this.frameCallbackRegistry.delete(callbackId)
    },
    manageStateFrameCallback(callbackId: number, state: boolean) {
      if (callbackId === -1) return
      if (state) {
        if (!this.activeFrameCallbacks.has(callbackId)) {
          this.activeFrameCallbacks.add(callbackId)
          this.runCallbacks(this.nextCallId)
        }
        return
      }
      const cb = this.frameCallbackRegistry.get(callbackId)
      if (cb) cb.startTime = null
      this.activeFrameCallbacks.delete(callbackId)
      if (this.activeFrameCallbacks.size === 0) this.nextCallId += 1
    },
  }

  g._frameCallbackRegistry = registry
  if (g.global && g.global !== g) {
    ;(g.global as typeof globalThis & { _frameCallbackRegistry?: unknown })._frameCallbackRegistry = registry
  }
}

// =============================================================================
// engineUpdateProps — THE fast path. Upstream's `_updateProps` is RN's "set view
// props without touching React state". On gpui that's the animated-style overlay:
// resolve the op's target → globalId, merge its style keys into the pending-ops map,
// and schedule a single coalesced rAF flush. Normalize the style values the SAME way
// the reconciler serializes them, so Rust's `from_json` reads them identically.
// =============================================================================

const SEAM_DEBUG =
  typeof process !== 'undefined' && !!(process as { env?: Record<string, string> }).env?.RNGPUI_SEAM_DEBUG
let updatePropsCalls = 0

function engineUpdateProps(operations: Array<{ shadowNodeWrapper: unknown; updates: StyleProps }>): void {
  let any = false
  for (const op of operations) {
    const globalId = resolveGlobalId(op.shadowNodeWrapper)
    if (globalId == null) {
      if (SEAM_DEBUG) {
        console.error(
          `[seam] _updateProps op dropped: unresolved target ${JSON.stringify(op.shadowNodeWrapper)} keys=${Object.keys(op.updates).join(',')}`,
        )
      }
      continue
    }
    const prev = PENDING_OPS.get(globalId) ?? {}
    for (const [key, value] of Object.entries(op.updates)) {
      prev[key] = normalizeUpdatePropValue(key, value)
      if (SEAM_DEBUG && prev[key] === undefined) {
        // an undefined value silently VANISHES at the JSON host crossing — the
        // key never reaches the overlay. always worth a loud line.
        console.error(`[seam] _updateProps key dropped as undefined: ${key} (raw ${typeof value})`)
      }
    }
    PENDING_OPS.set(globalId, prev)
    any = true
  }
  if (SEAM_DEBUG) {
    updatePropsCalls++
    console.error(`[seam] _updateProps call #${updatePropsCalls} ops=${operations.length} any=${any}`)
  }
  if (any) scheduleFlush()
}

// reanimated emits transforms as `transform: [{translateX: n}, …]` and colors as
// processed ints; pass plain numbers/strings through. Drop the reanimated-internal
// `_requiresAnimatedComponent` marker. Colors arrive as RN-processed numbers from the
// worklet color interpolation — convert to a CSS rgba string the Rust color parser reads.
function normalizeUpdatePropValue(key: string, value: unknown): unknown {
  if (value == null) return value
  if (isColorKey(key) && typeof value === 'number') {
    return processedColorToCss(value)
  }
  return value
}

function isColorKey(key: string): boolean {
  return (
    key === 'color' ||
    key === 'backgroundColor' ||
    key === 'borderColor' ||
    key === 'borderTopColor' ||
    key === 'borderRightColor' ||
    key === 'borderBottomColor' ||
    key === 'borderLeftColor' ||
    key === 'tintColor' ||
    key === 'shadowColor'
  )
}

// RN processes colors to a 32-bit ARGB int on the worklet side (reanimated's color
// interpolation returns this form). Convert to `rgba(r,g,b,a)` so the Rust css parser
// reads it.
function processedColorToCss(argb: number): string {
  const a = ((argb >> 24) & 0xff) / 255
  const r = (argb >> 16) & 0xff
  const g = (argb >> 8) & 0xff
  const b = argb & 0xff
  return `rgba(${r},${g},${b},${a})`
}

// =============================================================================
// install on import — upstream's core.ts/mappers.ts read globals like
// __reanimatedModuleProxy on load, so install before any upstream import resolves.
// =============================================================================

installReanimatedNativeSeam()

// default export — upstream's `specs/NativeReanimatedModule` is
// `export default TurboModuleRegistry.get('ReanimatedModule')`; the bundler redirect
// routes that import here.
export default {
  installTurboModule(): boolean {
    installReanimatedNativeSeam()
    return true
  },
}

// platform functions — upstream's `platformFunctions/*` redirect here. These run on
// the JS thread (single runtime). Mark each as a worklet builtin shape so upstream's
// areWorkletsEqual doesn't choke.
function markWorkletBuiltin<T extends (...args: never[]) => unknown>(name: string, fn: T): T {
  Object.defineProperty(fn, '__workletHash', { value: 0, enumerable: false, configurable: true })
  Object.defineProperty(fn, '__initData', {
    value: { code: fn.toString(), location: name },
    enumerable: false,
    configurable: true,
  })
  Object.defineProperty(fn, '__closure', { value: {}, enumerable: false, configurable: true, writable: true })
  return fn
}

function scrollToImpl(animatedRef: unknown, x: number, y: number, _animated: boolean): void {
  engineScrollTo(animatedRef, x, y)
}
function measureImpl(animatedRef: unknown): MeasuredDimensions | null {
  return engineMeasure(animatedRef)
}
function setNativePropsImpl(animatedRef: unknown, updates: StyleProps): void {
  engineUpdateProps([{ shadowNodeWrapper: animatedRef, updates }])
}
function dispatchCommandImpl(): void {}
function setGestureStateImpl(): void {}

export const scrollTo = markWorkletBuiltin('scrollTo', scrollToImpl)
export const measure = markWorkletBuiltin('measure', measureImpl)
export const setNativeProps = markWorkletBuiltin('setNativeProps', setNativePropsImpl)
export const dispatchCommand = markWorkletBuiltin('dispatchCommand', dispatchCommandImpl)
export const setGestureState = markWorkletBuiltin('setGestureState', setGestureStateImpl)

// also expose the proxy install so a caller can re-run it (idempotent).
export { installReanimatedNativeSeam }

// satisfy the unused-binding lint for the optional keyboard handler shape.
export type { SerializableLike }
