// react-native-worklets — single-runtime surface for the gpui Hermes target.
//
// gpui runs ONE Hermes runtime (no UI/JS thread split, no SharedArrayBuffer, no
// worklet serialization). So every cross-runtime primitive here degrades to LOCAL
// execution: a worklet "shipped to the UI runtime" is just run inline via
// queueMicrotask, `runOnJS` is identity (we ARE the JS runtime), and a shareable is
// the value itself (no SAB slot). This is exactly soot's no-peer fallback branch
// (packages/compat/src/stubs/react-native-worklets-pkg/index.ts) with the entire
// SAB/channel machinery removed, since a single runtime never needs it.
//
// True cross-thread is out of scope and unnecessary for Tamagui animations: the spring
// driver, the `useAnimatedStyle` mapper, and `_updateProps` all run on this one thread,
// in rAF order, exactly as upstream reanimated expects when KIND === UI.

// Force the reanimated native seam to evaluate (and install `__reanimatedModuleProxy`,
// `global._updateProps`, `__RUNTIME_KIND`, the version shims, the frame-callback
// registry) — react-native-worklets is ALWAYS imported by reanimated before its
// NativeReanimated constructor runs, and reanimated's own seam import can be
// tree-shaken when the turbomodule path is dead, so this is the reliable install
// point. The seam's globals must exist before the first `withSpring(...)` evaluates.
import './seam'

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
// runtime kind — gpui has ONE runtime; we claim UI (2) so reanimated v4's
// runtimeKind branches take the UI path (animations actually run, setNativeProps
// executes, cancelAnimation writes the SV directly). Mirrors soot.
// =============================================================================

export enum RuntimeKind {
  ReactNative = 1,
  UI = 2,
  Worker = 3,
}

const SOOTSIM_UI_RUNTIME_HOLDER = { __rngpui_ui_runtime: true }
const SOOTSIM_UI_SCHEDULER_HOLDER = { __rngpui_ui_scheduler: true }

export function getUIRuntimeHolder(): object {
  return SOOTSIM_UI_RUNTIME_HOLDER
}

export function getUISchedulerHolder(): object {
  return SOOTSIM_UI_SCHEDULER_HOLDER
}

export const UIRuntimeId = 1

// =============================================================================
// createShareable — single-runtime: return the upstream-decorated value as a plain
// in-realm mutable. `mutables.ts` calls `createShareable(UIRuntimeId, initial,
// { hostDecorator, guestDecorator })`; upstream's `mutableHostDecorator` builds the
// full SharedValue surface (value getter/setter, modify, addListener, _animation,
// _isReanimatedSharedValue) around `{value: initial}`. With one runtime we just hand
// that decorated surface back — no SAB slot, no peer sync. Every read/write is local
// and synchronous, which is exactly what the spring driver + useAnimatedStyle mapper
// need on a single thread.
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

export function createShareable<TValue, THostDecorated = unknown, TGuestDecorated = unknown>(
  hostRuntimeId: number,
  initial: TValue,
  config?: ShareableConfig<THostDecorated, TGuestDecorated>,
): unknown {
  // legacy single-arg form (`createShareable(value)`) — passthrough.
  if (config === undefined && typeof hostRuntimeId !== 'number') {
    return hostRuntimeId
  }
  const base: { value: TValue } = { value: initial }
  // upstream wraps `hostDecorator` with the babel-worklets transform, which reads
  // captured variables via `this.__closure`. invoking it locally requires `this` to
  // be the function itself (same convention the worklet runtime uses).
  const decorated = config?.hostDecorator
    ? config.hostDecorator.call(config.hostDecorator, base)
    : base
  return decorated
}

// =============================================================================
// runOnJS / runOnUI / scheduleOnUI / scheduleOnRN — single runtime: local exec.
// =============================================================================

/** We ARE the JS runtime, so runOnJS is identity (the wrapper just calls fn). */
export function runOnJS<T extends (...args: unknown[]) => unknown>(fn: T): T {
  return fn
}

/** runOnUI returns a wrapper that schedules the worklet on the local microtask path. */
export function runOnUI<T extends (...args: unknown[]) => unknown>(fn: T): T {
  return ((...args: unknown[]) => {
    scheduleOnUI(fn, ...args)
  }) as unknown as T
}

export function runOnRuntime<T extends (...args: unknown[]) => unknown>(_runtime: unknown, fn: T): T {
  return ((...args: unknown[]) => scheduleOnUI(fn, ...args)) as unknown as T
}

/** scheduleOnRN(fn, ...args) — async call on the (one) JS runtime. */
export function scheduleOnRN<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ...args: unknown[]
): void {
  if (typeof fn !== 'function') return
  queueMicrotask(() => {
    try {
      fn.apply(null, args)
    } catch (err) {
      console.error('[rngpui worklets] scheduleOnRN threw:', err)
    }
  })
}

/** scheduleOnUI(fn, ...args) — run the worklet locally on the microtask path. */
export function scheduleOnUI<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ...args: unknown[]
): void {
  queueMicrotask(() => {
    try {
      // call with fn as `this` so the babel-emitted `this.__closure.X` / `this._recur`
      // references inside a worklet body resolve.
      ;(fn as { _recur?: unknown })._recur = fn
      fn.apply(fn, args)
    } catch (err) {
      console.error('[rngpui worklets] scheduleOnUI threw:', err)
    }
  })
}

/**
 * Invoke a GestureDetector lifecycle callback. Single runtime: always run locally,
 * synchronously, with `this = cb` so worklet-body closure refs resolve.
 */
export function invokeGestureCallback(
  // biome-ignore lint/suspicious/noExplicitAny: gesture callbacks carry event-specific payloads
  cb: ((...a: any[]) => unknown) | null | undefined,
  _gesture: { _runOnJS?: boolean } | null | undefined,
  ...args: unknown[]
): void {
  if (typeof cb !== 'function') return
  ;(cb as { _recur?: unknown })._recur = cb
  cb.apply(cb, args)
}

export function executeOnUIRuntimeSync<T extends (...args: unknown[]) => unknown>(fn: T): T {
  return fn
}

export function runOnUISync<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ...args: unknown[]
): unknown {
  ;(fn as { _recur?: unknown })._recur = fn
  return fn.apply(fn, args)
}

export function runOnUIAsync<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ...args: unknown[]
): Promise<unknown> {
  return Promise.resolve(runOnUISync(fn, ...args))
}

// =============================================================================
// shareables — identity (single runtime).
// =============================================================================

export function makeShareable<T>(value: T): T {
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
// runtime-kind type guards — gpui claims UI, so isUIRuntime/isWorkletRuntime are
// true and isRNRuntime is false (matches __RUNTIME_KIND=2). Upstream gates the
// runOnUI hop on these; reporting UI keeps every animation path inline.
// =============================================================================

export function getRuntimeKind(): RuntimeKind {
  return RuntimeKind.UI
}

export function scheduleOnRuntime(_runtime: unknown, fn: WorkletFunction, ...args: unknown[]) {
  scheduleOnUI(fn, ...args)
}

export function isRNRuntime(): boolean {
  return false
}
export function isUIRuntime(): boolean {
  return true
}
export function isWorkerRuntime(): boolean {
  return false
}
export function isWorkletRuntime(): boolean {
  return true
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

// install `globalThis.__workletsModuleProxy` so reanimated's NativeWorklets constructor
// doesn't throw "Native part of Worklets doesn't seem to be initialized" before the
// bundle finishes evaluating. Identity-shaped serializables + local scheduling — there
// is one worklet execution path (this module) for mappers, useAnimatedStyle, _updateProps.
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
    getUIRuntimeHolder: () => SOOTSIM_UI_RUNTIME_HOLDER,
    getUISchedulerHolder: () => SOOTSIM_UI_SCHEDULER_HOLDER,
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
