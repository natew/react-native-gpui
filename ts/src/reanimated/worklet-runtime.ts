// cross-runtime worklet runtime + shared-slot-backed shared values.
//
// faithful port of sootsim's worklet-runtime.ts
// (~/soot/packages/sootsim-engine/src/render-worker/worklet-runtime.ts) adapted
// for rngpui's two-Hermes-runtime architecture. it runs on BOTH the React
// runtime (role 'react', even slot ids — sootsim's "tenant") and the UI runtime
// (role 'ui', odd slot ids — sootsim's "shell"). it exposes a small surface that
// the compat stubs (react-native-worklets/worklets.ts, the reanimated seam) call
// into:
//
//   - allocSharedValueSlot(initial) -> id
//   - readSlot(id) / writeSlot(id, value)
//   - subscribeSlot(id, fn)   (local-listener fan-out)
//   - dispatchWorklet(target, fn, args, opts) -> Promise<value>
//
// the babel transform emits worklets with `__initData.code`, `__closure`,
// `__workletHash`. we serialize the closure (replacing SharedValue refs with
// {kind:'sv', id} markers), ship code+closureSpec+args over the channel, and
// re-eval on the other side.
//
// the channel (send/hasPeer) is injected at construction; inbound messages arrive
// via the channel adapter calling `runtime.onMessage(msg)` (see worklet-channel.ts).
//
// shared slots: instead of a SharedArrayBuffer parameter we read the plain
// ArrayBuffer installed by the rust host at `globalThis.__rngpui_svSlots` — both
// runtimes see the SAME backing memory, so a Float64Array view works identically
// to sootsim's SAB. layout: a small header followed by `capacity` Float64 slots.
// Boolean shared values store as 0 / 1. object/array shared values live in
// per-runtime object-slot maps and propagate over the channel as structured
// snapshots.
//
// what was stripped vs. sootsim (no rngpui counterpart): the animatedBridge
// listener relay (registerAnimatedView / unregisterAnimatedView /
// applyAnimatedProps message kinds and onAnimatedBridge / postAnimatedBridge),
// traceReanimated debug hooks, and surface/mirror notions. everything else is a
// faithful port — the lessons embedded in the comments are the design contract.

const SAB_MAGIC = 0x504e9a01
const SAB_HEADER_FLOATS = 4 // magic, capacity, _pad, _pad
const DEFAULT_CAPACITY = 262144
// object SVs live in a per-runtime JS Map (objectSlots), not the shared Float64
// array, so they need only a unique id — never a Float64 cell — and therefore
// must NOT be bounded by the slot `capacity` (which exists solely to bound
// `floats[]`). they get a DISJOINT high id range with their own counter +
// free-list. two reasons it must be disjoint, not shared:
//   1. a numeric id alone then identifies its kind (id >= OBJECT_ID_BASE →
//      object slot), so a primitive free and an object free can never alias
//      and clobber the same cell via releaseSlotState().
//   2. high-churn screens (hundreds of reanimated rows + tamagui configRef
//      object-SVs mounting/unmounting) used to drain the 262144 primitive id
//      space — GC-driven freeSlot lags the burst, so the monotonic counter
//      outran reclaim and `allocSlotId` threw. object slots have no slot ceiling,
//      matching upstream reanimated where object shareables are plain GC'd JS
//      objects.
// 2^32 base keeps ids exact integers and far above any primitive id; the
// capacity is a final safety valve only.
const OBJECT_ID_BASE = 0x1_0000_0000 // 2^32
const OBJECT_ID_CAPACITY = 0x1_0000_0000 // 2^32 ids (~4.3B) — effectively unbounded
type WorkletBuiltinName = string

// kinds of values that can appear in a closure spec
export type ValueSpec =
  | { kind: 'sv'; id: number }
  // object SV — same id-space as primitive 'sv', but the live value lives in a
  // per-runtime Map<id, unknown> rather than the shared Float64 slots.
  | { kind: 'svObject'; id: number }
  // a reanimated mutable that reached the cross-runtime chokepoint without an
  // `_id` AND could not be slot-backed at ship time (slot pool exhausted).
  // instead of deep-cloning it into a plain object — whose peer-side `.get()`
  // would be missing and crash tamagui's animated worklet with `configRef.get is
  // not a function` — we ship a detached snapshot. the peer rebuilds a read-only
  // object-SV-shaped proxy whose `.get()`/`.value` return this snapshot.
  | { kind: 'svDetached'; value: unknown }
  // a reanimated animation object (withSpring/withTiming/... result) stamped by
  // reanimated-host.ts with its {type, args} provenance. live animation objects
  // carry runtime-created onFrame/onStart closures that CANNOT cross (they'd
  // degrade to async jsCallback proxies and the animation dies — the dialog-bg
  // regression); instead the receiving runtime re-creates the animation from its
  // own factory table (__rngpuiReanimatedAnimationFactories).
  | { kind: 'animation'; type: string; args: ValueSpec[] }
  | { kind: 'plain'; value: unknown }
  // runtime-provided functions such as runOnJS / withTiming. upstream
  // workletization captures these imports in `__closure`; on real iOS the UI
  // runtime resolves them as builtins, so we rebind by name on the receiving
  // runtime instead of trying to structured-clone a function.
  | { kind: 'builtin'; name: WorkletBuiltinName }
  | {
      kind: 'fn'
      code: string
      closureSpec: ClosureSpec
      hash: number
      closureId: number
    }
  // upstream createSerializable({__init}) / makeShareableCloneRecursive handles:
  // the receiving runtime evaluates the initializer worklet and uses its return
  // value as the closure object. useAnimatedRef depends on this.
  | { kind: 'initializer'; init: WorkletFunctionSpec }
  // upstream useAnimatedRef must be callable on the UI runtime and return a
  // shadow-node wrapper/tag synchronously. on rngpui the "tag" carried is the
  // globalId (the reconciler Instance `.id` rust keys on).
  | { kind: 'animatedRef'; viewTag: number }
  | { kind: 'animatedRefSlot'; slotId: number }
  // a callback that ran through `runOnJS` (or equivalent) on the React runtime.
  // when re-bound on the UI side, calling it ships a `runJSCallback` message back
  // so the React runtime invokes the original fn with the rebound args.
  | { kind: 'jsCallback'; id: number }
  | { kind: 'undef' }
  // arrays / nested plain objects that may themselves contain sv / fn /
  // jsCallback refs.
  | { kind: 'array'; items: ValueSpec[] }
  | { kind: 'object'; entries: Array<[string, ValueSpec]> }
  // a `makeShareable`-stamped record (reanimated `remoteState`, scroll handler
  // state, …). upstream's `serializableMappingCache` maps the SAME shareable to
  // the SAME UI-runtime clone across every (re-)ship so the mapper's mutations
  // (`state.last`/`animations`) persist across stopMapper/startMapper. `id` is
  // stable for the lifetime of the source object; `snapshot` is the deep
  // `kind:'object'` entries used ONLY for first materialization.
  | { kind: 'shareableRef'; id: number; snapshot: Array<[string, ValueSpec]> }

export type ClosureSpec = Record<string, ValueSpec>
type WorkletFunctionSpec = Extract<ValueSpec, { kind: 'fn' }>

const WORKLET_BUILTIN_NAME = Symbol.for('rngpui.workletBuiltinName')
const LEGACY_WORKLET_BUILTIN_NAME = Symbol.for('rngpui.workletBuiltin')
const SERIALIZABLE_MAPPING_CACHE = Symbol.for('rngpui.serializableMappingCache')
const WORKLET_BUILTIN_REGISTRY = '__rngpui_worklet_builtins'
const REANIMATED_ANIMATION_FACTORIES = '__rngpuiReanimatedAnimationFactories'
const REANIMATED_VALUE_SETTER = '__rngpuiReanimatedValueSetter'

const KNOWN_WORKLET_BUILTINS = new Set([
  'cancelAnimation',
  'dispatchCommand',
  'interpolate',
  'interpolateColor',
  'measure',
  'runOnJS',
  'runOnRuntime',
  'runOnUI',
  'scheduleOnRN',
  'scheduleOnUI',
  'scrollTo',
  'setGestureState',
  'setNativeProps',
  'withClamp',
  'withDecay',
  'withDelay',
  'withRepeat',
  'withSequence',
  'withSpring',
  'withTiming',
])

function installWorkletGlobalAliases(): void {
  const g = globalThis as typeof globalThis & { global?: typeof globalThis }
  if (typeof g.global === 'undefined') {
    Object.defineProperty(g, 'global', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: globalThis,
    })
  }
}

type WorkletBuiltinRegistry = Map<string, unknown>

function getWorkletBuiltinRegistry(): WorkletBuiltinRegistry {
  installWorkletGlobalAliases()
  const g = globalThis as unknown as {
    [WORKLET_BUILTIN_REGISTRY]?: WorkletBuiltinRegistry
  }
  if (!g[WORKLET_BUILTIN_REGISTRY]) {
    g[WORKLET_BUILTIN_REGISTRY] = new Map()
  }
  return g[WORKLET_BUILTIN_REGISTRY]
}

export function markWorkletBuiltin<T extends (...args: never[]) => unknown>(
  name: string,
  fn: T,
): T {
  try {
    Object.defineProperty(fn, WORKLET_BUILTIN_NAME, {
      value: name,
      enumerable: false,
      configurable: true,
      writable: false,
    })
  } catch {}
  getWorkletBuiltinRegistry().set(name, fn)
  return fn
}

/**
 * Register a worklet builtin by name. The integrator populates this from the
 * UI-side upstream reanimated module so that closures captured on the React side
 * (which serialize builtins as {kind:'builtin', name}) resolve to the real UI
 * implementation on deserialization. See bindBuiltin's special cases.
 *
 * The value is usually a function (withSpring, scrollTo, …) but may be a namespace
 * object exposed to worklet bodies by name (e.g. `Easing`), so the registry holds
 * `unknown`. Functions also get the hidden name brand (for outbound serialization);
 * non-functions just land in the registry for by-name resolution.
 */
export function registerWorkletBuiltin(name: string, value: unknown): void {
  if (typeof value === 'function') {
    markWorkletBuiltin(name, value as (...args: never[]) => unknown)
    return
  }
  getWorkletBuiltinRegistry().set(name, value)
}

function getSerializedBuiltinName(value: unknown): string | null {
  if (typeof value !== 'function') return null
  const branded = (value as { [WORKLET_BUILTIN_NAME]?: unknown })[WORKLET_BUILTIN_NAME]
  if (typeof branded === 'string') return branded
  const legacyBranded = (value as { [LEGACY_WORKLET_BUILTIN_NAME]?: unknown })[
    LEGACY_WORKLET_BUILTIN_NAME
  ]
  if (typeof legacyBranded === 'string') return legacyBranded
  const name = value.name
  return KNOWN_WORKLET_BUILTINS.has(name) ? name : null
}

function getSerializableMapping(value: unknown): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined
  }
  const cache = (globalThis as Record<symbol, unknown>)[SERIALIZABLE_MAPPING_CACHE]
  if (!cache || typeof (cache as { get?: unknown }).get !== 'function') {
    return undefined
  }
  try {
    return (cache as WeakMap<object, unknown>).get(value as object)
  } catch {
    return undefined
  }
}

export interface WorkletDispatchOptions {
  // when false, dispatch is fire-and-forget (no reply expected).
  awaitReply?: boolean
  // native reanimated wraps UI-thread event handlers with
  // `global.__frameTimestamp = eventTimestamp`, runs the handler, then
  // `global.__flushAnimationFrame(eventTimestamp)`. gesture callbacks that start
  // animations need the same event-clock envelope.
  eventTimestamp?: number
}

// messages exchanged across the channel. the channel implementation chooses how
// to wrap/unwrap these onto the real protocol (JSON over the rust host fns).
export type WorkletMessage =
  | {
      type: 'runWorklet'
      runId: number
      code: string
      hash: number
      closureId: number
      closureSpec: ClosureSpec
      argsSpec: ValueSpec[]
      // when true, reply is expected with the return value
      awaitReply: boolean
      eventTimestamp?: number
    }
  | {
      type: 'workletReply'
      runId: number
      ok: boolean
      returnValueSpec?: ValueSpec
      error?: string
    }
  | {
      type: 'workletDone'
      runId: number
      ok: boolean
      error?: string
    }
  | {
      type: 'svUpdate'
      svId: number
      value: number
    }
  | {
      // coalesced version of svUpdate — multiple slot writes within a single JS
      // turn flush as one message. dramatic crossing reduction on hot paths like
      // animated tickers. also carries object SV updates as an optional second
      // list so a mixed-write turn ships a single combined message.
      type: 'svUpdateBatch'
      updates: Array<{ svId: number; value: number }>
      objectUpdates?: Array<{ svId: number; value: unknown }>
    }
  | {
      type: 'svAlloc'
      svId: number
      // initial value (pre-written to slot). fire-and-forget today.
      initial: number
      // the slot holds a boolean shared value (stored Float64 0/1). lets the
      // peer's proxy reads restore the boolean type, matching real reanimated
      // where `useSharedValue(false).value === false`, not `0`.
      bool?: boolean
    }
  | {
      // object SV allocation — peer seeds its objectSlots Map with the initial
      // value so subsequent reads (before any update arrives) return the right
      // shape. sent fire-and-forget at alloc time.
      type: 'svObjectAlloc'
      svId: number
      initial: unknown
    }
  | {
      // a SharedValue's JS wrapper was garbage-collected on the owning runtime
      // (FinalizationRegistry). the owner returns the slot id to its free-list
      // and tells the peer to drop its mirror state for that id so a future
      // re-alloc of the same id starts clean. the peer must NOT add the id to its
      // own free-list — only the owning (even=react / odd=ui) runtime allocates
      // that id.
      type: 'svFree'
      svId: number
    }
  | {
      // UI-side worklet calling a React-side runOnJS-wrapped fn. the React
      // runtime looks up callbackId in its js-callback registry and invokes it
      // with the rebound args.
      type: 'runJSCallback'
      callbackId: number
      argsSpec: ValueSpec[]
    }

// a Channel is the runtime-specific bridge to the other side. messages are
// strings through the rust host fns (FIFO per direction).
export interface WorkletChannel {
  send(msg: WorkletMessage): void
  // return whether this side has a peer at all. true once the host bridge fn is
  // present in this runtime.
  hasPeer(): boolean
}

interface PendingReply {
  resolve(spec: ValueSpec | undefined): void
  reject(err: Error): void
}

interface SerializedWorkletCacheEntry {
  code: string
  hash: number
  closure: Record<string, unknown>
  spec: WorkletFunctionSpec
}

function getMaterializedClosureCacheKey(hash: number, closureId: number): string {
  return `${hash}:${closureId}`
}

function readOwnNumber(value: object, key: string): number | null {
  const desc = Object.getOwnPropertyDescriptor(value, key)
  if (!desc || !('value' in desc)) return null
  return typeof desc.value === 'number' && Number.isFinite(desc.value) ? desc.value : null
}

function coerceSlotValue(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value && typeof value === 'object') {
    const current = readOwnNumber(value, 'current')
    if (current !== null) return current
    const toValue = readOwnNumber(value, 'toValue')
    if (toValue !== null) return toValue
  }
  return Number.NaN
}

// cached slot-exhaustion errors. thrown (and caught by createShareable) on every
// failed alloc during a storm; sharing one instance per kind avoids building a
// fresh Error + stack hundreds of thousands of times, which on its own can OOM
// the runtime.
const SAB_SLOT_EXHAUSTION_ERROR = new Error('worklet-runtime: shared slot exhaustion')
const OBJECT_SLOT_EXHAUSTION_ERROR = new Error(
  'worklet-runtime: id space exhaustion (object slot)',
)

export type WorkletRuntimeRole = 'react' | 'ui'

// the singleton runtime per Hermes runtime. compat stubs call getWorkletRuntime().
export class WorkletRuntime {
  private channel: WorkletChannel
  private buffer: ArrayBuffer
  private floats: Float64Array
  private capacity: number
  // local slot listener registry. fired both by local writes (after the slot
  // write lands) and by inbound svUpdate messages from the peer.
  private listeners = new Map<number, Set<(value: number) => void>>()
  private lastSlotListenerValue = new Map<number, number>()
  // slot ids returned by freeSlot(), available for reuse. real reanimated
  // releases the native Shareable when a JS Mutable is garbage-collected;
  // freeSlot() is the faithful analog (driven by a FinalizationRegistry in the
  // worklets stub). without reuse the monotonic nextId climbs until
  // `id >= capacity` and a long-running app crashes with "slot exhaustion".
  // freedSet gives O(1) double-free protection (a slot must not land on the list
  // twice or two SharedValues would alias one cell).
  private freeSlots: number[] = []
  private freedSet = new Set<number>()
  // object-slot free-list, disjoint from the primitive one above.
  private freeObjectSlots: number[] = []
  private freedObjectSet = new Set<number>()
  // SharedValue proxies are cached by slot id so every worklet closure that
  // deserializes a ref to the same shared value gets back the SAME proxy object.
  // upstream reanimated has exactly one `Mutable` per shared value, and its
  // `valueSetter` cancels a running animation by reading the per-object
  // `mutable._animation`. minting a fresh proxy per deserialization fragments
  // `_animation`: a direct `.value =` write from one worklet (a gesture's
  // onUpdate) can no longer cancel a `withSpring` started from another (the
  // previous gesture's onEnd), so the orphaned spring keeps writing the slot and
  // fights the next gesture. one proxy per slot restores upstream's
  // single-object-per-shared-value identity.
  private svProxyCache = new Map<number, SharedValueProxy>()
  private svObjectProxyCache = new Map<number, ObjectSharedValueProxy>()
  // primitive slots that hold a boolean shared value. the slot array only stores
  // Float64, so booleans live as 0/1 — this set lets reads (proxy + getSync)
  // restore the boolean type so `useSharedValue(false).value === false` like real
  // reanimated, instead of leaking a `0` that breaks `=== false` checks.
  private boolSlots = new Set<number>()
  // monotonic id allocator. react gets even ids, ui gets odd, so there's no
  // collision and the two runtimes allocate without coordination.
  private nextId: number
  // object-slot allocator, disjoint high range (see OBJECT_ID_BASE). same
  // even=react / odd=ui stride.
  private nextObjectId: number
  private idStride: number
  private role: WorkletRuntimeRole
  private statPrimitiveAllocs = 0
  private statObjectAllocs = 0
  private statReusedAllocs = 0
  private statFrees = 0
  // slot-exhaustion logging throttle. a re-render storm can hit the exhausted
  // allocator hundreds of thousands of times in a burst; building an Error+stack
  // and console.error-ing each time is itself enough to OOM/crash the runtime.
  private exhaustionLoggedAt = 0
  private exhaustionSuppressed = 0
  private runIdCounter = 1
  private pending = new Map<number, PendingReply>()
  // worklet fn cache by hash so we don't re-eval identical bodies.
  private workletCache = new Map<number, (...args: unknown[]) => unknown>()
  // receiver-side closure materialization cache. sender-side closureId values
  // name a specific worklet function + closure-object pairing; the receiving
  // runtime should hydrate that closure clone once and reuse it, matching
  // reanimated's UI-runtime clone lifetime instead of rebuilding every frame.
  private materializedClosureCache = new Map<string, Record<string, unknown>>()
  private remoteWorkletCache = new Map<string, WorkletFn>()
  // persistent objects for `makeShareable` records, keyed by the source's stable
  // shareable id. mirrors upstream `serializableMappingCache` ("already converted
  // → return the same clone"): a re-shipped shareable (every stopMapper/
  // startMapper re-trigger ships the closure again) MUST resolve to the SAME
  // object so the mapper's `state.last`/`animations` mutations persist across
  // registrations. without this, the 2nd withSpring on a prop re-seeds from a
  // stale snapshot and snaps.
  private shareableCache = new Map<number, object>()
  // outbound cache by source function identity. babel-emitted worklet closures
  // are snapshots, so the same fn with the same closure object can reuse the
  // already-walked closure spec instead of reserializing large mapper helpers.
  private serializedWorklets = new WeakMap<object, SerializedWorkletCacheEntry>()
  private nextSerializedClosureId = 1
  // js-callback registry: ids handed to runOnJS-tagged wrappers map to the
  // original React-local function. UI-side calls post a runJSCallback back; the
  // React runtime resolves through this map.
  private jsCallbacks = new Map<number, (...args: unknown[]) => unknown>()
  // memoize wrappers per source fn so re-registering the same callback does not
  // exhaust id space.
  private jsCallbackByFn = new WeakMap<
    object,
    { id: number; wrapper: (...args: unknown[]) => unknown }
  >()
  private nextJsCallbackId = 1
  private animatedRefSlots = new WeakMap<
    object,
    { slotId: number; unsubscribe?: () => void }
  >()
  private statRunJSCallbackSent = 0
  private statRunJSCallbackReceived = 0
  private statRunJSCallbackMissing = 0
  private pendingRunWorklets = new Set<number>()
  private statRunWorkletSent = 0
  private statRunWorkletDone = 0
  private statRunWorkletFailed = 0
  private statClosureCacheHits = 0
  private statClosureCacheMisses = 0
  // svUpdate coalescing — local writes within one JS turn batch into a single
  // crossing at microtask boundary. last-write-wins per slot. hot paths (animated
  // digit tickers, scroll-driven SVs) write the same slot many times per task;
  // coalescing collapses that traffic to one message per JS turn.
  private pendingPeerUpdates = new Map<number, number>()
  private peerFlushScheduled = false
  private statWriteRequests = 0
  private statBatchesSent = 0
  // object SV slots — non-primitive shareable values live here, keyed by the same
  // id-space as primitive slots. each runtime keeps its own copy (objects are
  // structured-cloned across the channel; identity is not preserved across
  // runtimes). reads return the local copy; writes update local + queue peer
  // notification.
  private objectSlots = new Map<number, unknown>()
  private objectListeners = new Map<number, Set<(value: unknown) => void>>()
  private pendingObjectUpdates = new Map<number, unknown>()

  constructor(opts: { channel: WorkletChannel; buffer: ArrayBuffer; role: WorkletRuntimeRole }) {
    installWorkletGlobalAliases()
    this.channel = opts.channel
    this.buffer = opts.buffer
    this.role = opts.role
    this.floats = new Float64Array(this.buffer)
    this.capacity = this.floats[1] || DEFAULT_CAPACITY

    const magic = this.floats[0]
    if (magic !== SAB_MAGIC) {
      throw new Error('worklet-runtime: shared-slot magic mismatch')
    }

    // ids start past the header. react uses even ids; ui uses odd; that way both
    // sides allocate without coordination and never collide.
    this.idStride = 2
    const firstEven =
      SAB_HEADER_FLOATS % 2 === 0 ? SAB_HEADER_FLOATS : SAB_HEADER_FLOATS + 1
    const firstOdd = firstEven + 1
    this.nextId = opts.role === 'ui' ? firstOdd : firstEven
    // object ids start at OBJECT_ID_BASE (even); ui takes the odd lane.
    this.nextObjectId = opts.role === 'ui' ? OBJECT_ID_BASE + 1 : OBJECT_ID_BASE
  }

  /**
   * Inbound channel entry point. The channel adapter calls this with each
   * decoded message. Public so the adapter (worklet-channel.ts) can wire it.
   */
  onMessage(msg: WorkletMessage): void {
    switch (msg.type) {
      case 'svUpdate': {
        // peer wrote — the shared cell is the source of truth. the queued payload
        // is only a listener wakeup and can lag newer writes when the runtime is
        // busy; never rewind the shared cell to the queued payload.
        this.fireLocalIfChanged(msg.svId, this.floats[msg.svId])
        return
      }
      case 'svUpdateBatch': {
        // peer flushed a coalesced batch of writes. iterate and apply each — same
        // fan-out semantics as svUpdate, just amortized. objectUpdates rides along
        // when the peer's turn touched both primitive and object SVs.
        if (Array.isArray(msg.updates)) {
          for (const u of msg.updates) {
            if (!u || typeof u.svId !== 'number' || typeof u.value !== 'number') {
              continue
            }
            // use the current shared value, not the queued payload. when gesture
            // frames are waiting in the queue, replaying payload values makes
            // UI-rendered animations visibly run in slow motion and alternate
            // stale/current transforms.
            this.fireLocalIfChanged(u.svId, this.floats[u.svId])
          }
        }
        if (Array.isArray(msg.objectUpdates)) {
          for (const u of msg.objectUpdates) {
            if (!u || typeof u.svId !== 'number') continue
            this.objectSlots.set(u.svId, u.value)
            this.fireObjectLocal(u.svId, u.value)
          }
        }
        return
      }
      case 'svAlloc': {
        // peer allocated; just keep our nextId past it to avoid future collisions.
        // both runtimes share the same buffer, so the allocator already seeded the
        // cell synchronously. do not overwrite here: a live write can race ahead of
        // this low-priority alloc message.
        if (this.floats[msg.svId] === 0 && msg.initial !== 0) {
          this.floats[msg.svId] = msg.initial
        }
        // mirror the boolean-slot tag so this side's proxy reads also restore the
        // boolean type for a peer-allocated boolean shared value.
        if (msg.bool) this.boolSlots.add(msg.svId)
        // ensure local nextId leapfrogs as needed.
        if (msg.svId >= this.nextId) {
          while (this.nextId <= msg.svId) this.nextId += this.idStride
        }
        return
      }
      case 'svObjectAlloc': {
        this.objectSlots.set(msg.svId, msg.initial)
        // object ids live in their own counter's range; leapfrog it (not nextId)
        // so this side never re-hands-out the peer's object id.
        if (msg.svId >= this.nextObjectId) {
          while (this.nextObjectId <= msg.svId) this.nextObjectId += this.idStride
        }
        return
      }
      case 'svFree': {
        // peer's SharedValue wrapper was GC'd. drop our mirror state for that id so
        // a future re-alloc at the same id starts clean. we do not own this id's
        // allocation parity, so it does NOT go on our free-list and nextId is left
        // untouched (a later svAlloc / svObjectAlloc for the same id re-seeds it).
        this.releaseSlotState(msg.svId)
        return
      }
      case 'runWorklet': {
        this.handleRunWorklet(msg)
        return
      }
      case 'workletDone': {
        if (this.pendingRunWorklets.delete(msg.runId)) {
          this.statRunWorkletDone++
          if (!msg.ok) this.statRunWorkletFailed++
        }
        return
      }
      case 'workletReply': {
        const pending = this.pending.get(msg.runId)
        if (!pending) return
        this.pending.delete(msg.runId)
        if (msg.ok) pending.resolve(msg.returnValueSpec)
        else pending.reject(new Error(msg.error ?? 'worklet error'))
        return
      }
      case 'runJSCallback': {
        this.statRunJSCallbackReceived++
        const fn = this.jsCallbacks.get(msg.callbackId)
        if (!fn) {
          this.statRunJSCallbackMissing++
          console.warn('[worklet-runtime] runJSCallback: no fn for id', msg.callbackId)
          return
        }
        try {
          const args = msg.argsSpec.map((spec) => this.deserializeValue(spec))
          fn.apply(null, args)
        } catch (err) {
          console.error('[worklet-runtime] runJSCallback threw:', err)
        }
        return
      }
    }
  }

  /**
   * Allocate a slot, write the initial value, and announce to the peer.
   * Returns the slot id. Slots 0..3 are reserved (header).
   */
  allocSharedValueSlot(initial: number, isBool = false): number {
    const id = this.allocSlotId(false)
    this.statPrimitiveAllocs++
    this.floats[id] = initial
    if (isBool) this.boolSlots.add(id)
    if (this.channel.hasPeer()) {
      this.channel.send({ type: 'svAlloc', svId: id, initial, bool: isBool || undefined })
    }
    return id
  }

  /**
   * Reuse a reclaimed slot id if one is available, else advance the matching
   * counter. Primitive and object ids live in DISJOINT ranges with their own
   * counters + free-lists (see OBJECT_ID_BASE): primitive ids index the shared
   * Float64 array so they are capacity-bounded; object ids are JS-Map-backed so
   * their range is effectively unbounded. A freed id is fully reset by
   * releaseSlotState() before it returns to its pool.
   */
  private allocSlotId(objectSlot: boolean): number {
    if (objectSlot) {
      const reused = this.freeObjectSlots.pop()
      if (reused !== undefined) {
        this.freedObjectSet.delete(reused)
        this.statReusedAllocs++
        return reused
      }
      if (this.nextObjectId >= OBJECT_ID_BASE + OBJECT_ID_CAPACITY) {
        this.logExhaustion()
        throw OBJECT_SLOT_EXHAUSTION_ERROR
      }
      const id = this.nextObjectId
      this.nextObjectId += this.idStride
      return id
    }
    const reused = this.freeSlots.pop()
    if (reused !== undefined) {
      this.freedSet.delete(reused)
      this.statReusedAllocs++
      return reused
    }
    if (this.nextId >= this.capacity) {
      // exhausted. do NOT advance nextId further (bounds the counter under a
      // storm). the caller catches and falls back to a local-only shareable so
      // exhaustion degrades gracefully instead of taking the runtime down.
      this.logExhaustion()
      throw SAB_SLOT_EXHAUSTION_ERROR
    }
    const id = this.nextId
    this.nextId += this.idStride
    return id
  }

  /**
   * Throttled exhaustion logging. A re-render storm can hit the exhausted
   * allocator hundreds of thousands of times in a burst; building an Error+stack
   * and console.error-ing each time is itself enough to OOM/crash the runtime.
   * Throttle to one log per window with a suppressed-count.
   */
  private logExhaustion(): void {
    this.exhaustionSuppressed++
    const now = Date.now()
    if (now - this.exhaustionLoggedAt > 2000) {
      console.error(
        `[worklet-runtime] slot exhaustion (+${this.exhaustionSuppressed} suppressed since last log)`,
        this.getSlotStats(),
      )
      this.exhaustionLoggedAt = now
      this.exhaustionSuppressed = 0
    }
  }

  /** true if `id` belongs to the disjoint object-slot id range. */
  private isObjectId(id: number): boolean {
    return id >= OBJECT_ID_BASE
  }

  /**
   * Clear every per-id structure for `id` and return the cell to zero. Shared by
   * freeSlot() (owner side) and the inbound 'svFree' handler (peer side); both
   * need the mirror dropped, only the owner recycles.
   */
  private releaseSlotState(id: number): void {
    this.listeners.delete(id)
    this.objectListeners.delete(id)
    this.objectSlots.delete(id)
    this.svProxyCache.delete(id)
    this.svObjectProxyCache.delete(id)
    this.lastSlotListenerValue.delete(id)
    this.pendingPeerUpdates.delete(id)
    this.pendingObjectUpdates.delete(id)
    this.boolSlots.delete(id)
    // only primitive ids index the shared array; object ids are out of range.
    if (!this.isObjectId(id)) this.floats[id] = 0
  }

  /**
   * Reclaim a SharedValue slot whose JS wrapper was garbage-collected. Mirrors
   * reanimated's native Shareable lifetime: once the JS Mutable is collected
   * nothing can reference the value (live mappers / useAnimatedStyle deps keep the
   * wrapper alive), so the slot is safe to recycle. Idempotent. Owner-only — a
   * runtime only frees ids it allocates (even=react / odd=ui); the parity guard
   * keeps a stray call from poisoning the peer's id space.
   */
  freeSlot(id: number): void {
    if (this.isObjectId(id)) {
      if (id >= OBJECT_ID_BASE + OBJECT_ID_CAPACITY) return
      // parity guard (even=react / odd=ui) — same role parity as nextId.
      if (id % this.idStride !== this.nextId % this.idStride) return
      if (this.freedObjectSet.has(id)) return
      this.freedObjectSet.add(id)
      this.statFrees++
      this.releaseSlotState(id)
      this.freeObjectSlots.push(id)
      if (this.channel.hasPeer()) {
        this.channel.send({ type: 'svFree', svId: id })
      }
      return
    }
    if (id < SAB_HEADER_FLOATS || id >= this.capacity) return
    if (id % this.idStride !== this.nextId % this.idStride) return
    if (this.freedSet.has(id)) return
    this.freedSet.add(id)
    this.statFrees++
    this.releaseSlotState(id)
    this.freeSlots.push(id)
    if (this.channel.hasPeer()) {
      this.channel.send({ type: 'svFree', svId: id })
    }
  }

  readSlot(id: number): number {
    return this.floats[id]
  }

  /**
   * Write a value to a slot, fire local listeners, and notify the peer.
   * skipNotify=true is used when a write came in via inbound svUpdate to avoid
   * bouncing it back. peer notifications coalesce per microtask — see
   * `enqueuePeerUpdate`.
   */
  writeSlot(id: number, value: unknown, skipNotify = false): boolean {
    const slotValue = coerceSlotValue(value)
    if (this.floats[id] === slotValue) return false
    this.floats[id] = slotValue
    this.fireLocal(id, slotValue)
    if (!skipNotify) this.enqueuePeerUpdate(id, slotValue)
    return true
  }

  /**
   * Used by createShareable's local-write echo: updates the cell and notifies the
   * peer, but skips fireLocal. Required because the local SharedValue's listeners
   * already fired the upstream fan-out — we don't want subscribeSlot listeners to
   * fire again and recurse back into upstream's `_value` setter.
   */
  syncToPeer(id: number, value: unknown): boolean {
    const slotValue = coerceSlotValue(value)
    if (this.floats[id] === slotValue) return false
    this.floats[id] = slotValue
    this.enqueuePeerUpdate(id, slotValue)
    return true
  }

  /**
   * Queue an svUpdate for the peer. Within a single JS turn, repeat writes to the
   * same slot collapse to last-write-wins. Flush happens at microtask boundary as
   * a single `svUpdateBatch` message.
   */
  private enqueuePeerUpdate(id: number, value: number): void {
    if (!this.channel.hasPeer()) return
    this.statWriteRequests++
    this.pendingPeerUpdates.set(id, value)
    this.scheduleUnifiedFlush()
  }

  /**
   * Single microtask schedules both primitive and object pending updates so a
   * mixed-write turn ships at most one combined batch message per microtask (not
   * two — one per kind). Both sides decode `svUpdateBatch` with optional
   * `objectUpdates` for backward compat.
   */
  private scheduleUnifiedFlush(): void {
    if (this.peerFlushScheduled) return
    this.peerFlushScheduled = true
    queueMicrotask(() => this.flushPendingPeerUpdates())
  }

  private flushPendingPeerUpdates(): void {
    this.peerFlushScheduled = false
    const hasPrimitives = this.pendingPeerUpdates.size > 0
    const hasObjects = this.pendingObjectUpdates.size > 0
    if (!hasPrimitives && !hasObjects) return
    if (!this.channel.hasPeer()) {
      this.pendingPeerUpdates.clear()
      this.pendingObjectUpdates.clear()
      return
    }
    const updates: Array<{ svId: number; value: number }> = []
    for (const [svId, value] of this.pendingPeerUpdates) {
      updates.push({ svId, value })
    }
    this.pendingPeerUpdates.clear()
    const objectUpdates: Array<{ svId: number; value: unknown }> = []
    for (const [svId, value] of this.pendingObjectUpdates) {
      objectUpdates.push({ svId, value: sanitizeForPeer(value) })
    }
    this.pendingObjectUpdates.clear()
    this.statBatchesSent++
    this.channel.send({
      type: 'svUpdateBatch',
      updates,
      objectUpdates: objectUpdates.length > 0 ? objectUpdates : undefined,
    })
  }

  /**
   * Force-flush any pending svUpdate batch to the peer. Used by tests and callers
   * that need a synchronous handoff. Normal callers should rely on the microtask
   * flush.
   */
  flushPeerUpdates(): void {
    this.flushPendingPeerUpdates()
  }

  // ---------------------------------------------------------------------
  // object SVs — separate high id range from primitive SVs, with values stored in
  // a per-runtime Map<id, unknown> rather than the shared Float64 array.
  // propagation goes through structured snapshots in the channel with the same
  // microtask-coalesced batching as primitives.
  // ---------------------------------------------------------------------

  /**
   * Allocate an object SV slot, seed the local Map, and announce to the peer.
   * Returns the slot id. Object SVs use the same react-even / ui-odd lane
   * convention as primitive SVs, but in a disjoint high range so object churn
   * never consumes primitive cells.
   */
  allocObjectSharedValueSlot(initial: unknown): number {
    const id = this.allocSlotId(true)
    this.statObjectAllocs++
    this.objectSlots.set(id, initial)
    if (this.channel.hasPeer()) {
      this.channel.send({
        type: 'svObjectAlloc',
        svId: id,
        initial: sanitizeForPeer(initial),
      })
    }
    return id
  }

  readObjectSlot(id: number): unknown {
    return this.objectSlots.get(id)
  }

  /**
   * Write an object value to a slot, fire local listeners, and queue a peer
   * notification. skipNotify avoids bouncing inbound updates back. Identity
   * comparison would be too expensive (deep equality); we always notify on write
   * — callers that want dedup should compare before calling.
   */
  writeObjectSlot(id: number, value: unknown, skipNotify = false): boolean {
    this.objectSlots.set(id, value)
    this.fireObjectLocal(id, value)
    if (!skipNotify) this.enqueueObjectUpdate(id, value)
    return true
  }

  /**
   * Object-slot equivalent of syncToPeer: updates the local Map and notifies the
   * peer, but skips fireObjectLocal. Used by createShareable to avoid recursing
   * into upstream listener fan-out.
   */
  syncObjectToPeer(id: number, value: unknown): boolean {
    this.objectSlots.set(id, value)
    this.enqueueObjectUpdate(id, value)
    return true
  }

  subscribeObjectSlot(id: number, fn: (value: unknown) => void): () => void {
    let set = this.objectListeners.get(id)
    if (!set) {
      set = new Set()
      this.objectListeners.set(id, set)
    }
    set.add(fn)
    return () => {
      set?.delete(fn)
      if (set?.size === 0) this.objectListeners.delete(id)
    }
  }

  private fireObjectLocal(id: number, value: unknown) {
    const set = this.objectListeners.get(id)
    if (!set) return
    for (const fn of set) {
      try {
        fn(value)
      } catch (err) {
        console.error('[worklet-runtime] object listener error', err)
      }
    }
  }

  private enqueueObjectUpdate(id: number, value: unknown): void {
    if (!this.channel.hasPeer()) return
    this.statWriteRequests++
    this.pendingObjectUpdates.set(id, value)
    this.scheduleUnifiedFlush()
  }

  /**
   * Snapshot of the per-runtime svUpdate coalescing counters. Read by tests for
   * empirical perf validation. ratio (writeRequests / batchesSent) is the average
   * coalescing factor — higher is better.
   */
  getPeerStats(reset = false): {
    writeRequests: number
    batchesSent: number
    pendingRunWorklets: number
    runWorkletsSent: number
    runWorkletsDone: number
    runWorkletsFailed: number
    closureCacheHits: number
    closureCacheMisses: number
  } {
    const out = {
      writeRequests: this.statWriteRequests,
      batchesSent: this.statBatchesSent,
      pendingRunWorklets: this.pendingRunWorklets.size,
      runWorkletsSent: this.statRunWorkletSent,
      runWorkletsDone: this.statRunWorkletDone,
      runWorkletsFailed: this.statRunWorkletFailed,
      closureCacheHits: this.statClosureCacheHits,
      closureCacheMisses: this.statClosureCacheMisses,
    }
    if (reset) {
      this.statWriteRequests = 0
      this.statBatchesSent = 0
      this.statRunWorkletSent = 0
      this.statRunWorkletDone = 0
      this.statRunWorkletFailed = 0
      this.statClosureCacheHits = 0
      this.statClosureCacheMisses = 0
    }
    return out
  }

  getSlotStats(): {
    role: WorkletRuntimeRole
    capacity: number
    nextId: number
    freeSlots: number
    freedSlots: number
    nextObjectId: number
    freeObjectSlots: number
    freedObjectSlots: number
    primitiveAllocs: number
    objectAllocs: number
    reusedAllocs: number
    frees: number
    listenerSlots: number
    objectListenerSlots: number
    objectSlots: number
    pendingPrimitiveUpdates: number
    pendingObjectUpdates: number
    runJSCallbackSent: number
    runJSCallbackReceived: number
    runJSCallbackMissing: number
  } {
    return {
      role: this.role,
      capacity: this.capacity,
      nextId: this.nextId,
      freeSlots: this.freeSlots.length,
      freedSlots: this.freedSet.size,
      nextObjectId: this.nextObjectId,
      freeObjectSlots: this.freeObjectSlots.length,
      freedObjectSlots: this.freedObjectSet.size,
      primitiveAllocs: this.statPrimitiveAllocs,
      objectAllocs: this.statObjectAllocs,
      reusedAllocs: this.statReusedAllocs,
      frees: this.statFrees,
      listenerSlots: this.listeners.size,
      objectListenerSlots: this.objectListeners.size,
      objectSlots: this.objectSlots.size,
      pendingPrimitiveUpdates: this.pendingPeerUpdates.size,
      pendingObjectUpdates: this.pendingObjectUpdates.size,
      runJSCallbackSent: this.statRunJSCallbackSent,
      runJSCallbackReceived: this.statRunJSCallbackReceived,
      runJSCallbackMissing: this.statRunJSCallbackMissing,
    }
  }

  subscribeSlot(id: number, fn: (value: number) => void): () => void {
    let set = this.listeners.get(id)
    if (!set) {
      set = new Set()
      this.listeners.set(id, set)
    }
    set.add(fn)
    return () => {
      set?.delete(fn)
      if (set?.size === 0) this.listeners.delete(id)
    }
  }

  private fireLocal(id: number, value: number) {
    this.lastSlotListenerValue.set(id, value)
    const set = this.listeners.get(id)
    if (!set) return
    for (const fn of set) {
      try {
        fn(value)
      } catch (err) {
        console.error('[worklet-runtime] listener error', err)
      }
    }
  }

  private fireLocalIfChanged(id: number, value: number) {
    if (Object.is(this.lastSlotListenerValue.get(id), value)) return
    this.fireLocal(id, value)
  }

  /**
   * Ship a worklet to the peer for execution. The fn must have been processed by
   * react-native-worklets/plugin so it carries __initData, __closure,
   * __workletHash. Returns a Promise that resolves with the worklet's return value
   * (when awaitReply is true) or undefined for fire-and-forget.
   */
  dispatchWorklet(
    fn: WorkletFn,
    args: unknown[],
    opts: WorkletDispatchOptions = {},
  ): Promise<unknown> {
    if (!this.channel.hasPeer()) {
      // no peer wired yet — degrade to local execution. matches the identity
      // passthrough behavior on cold-boot before the host bridge is present.
      return Promise.resolve(
        runWithEventFrameTimestamp(opts.eventTimestamp, () => fn.apply(fn, args)),
      )
    }
    const spec = this.serializeWorkletFunctionForDispatch(fn)
    const { code, hash, closureId, closureSpec } = spec
    const argsSpec = args.map((a) => this.serializeValueForDispatch(a))
    const awaitReply = !!opts.awaitReply
    const runId = this.runIdCounter++

    const promise = awaitReply
      ? new Promise<unknown>((resolve, reject) => {
          this.pending.set(runId, {
            resolve: (spec) =>
              resolve(spec === undefined ? undefined : this.deserializeValue(spec)),
            reject,
          })
        })
      : Promise.resolve(undefined)
    if (!awaitReply) {
      this.pendingRunWorklets.add(runId)
    }
    this.statRunWorkletSent++

    const message: Extract<WorkletMessage, { type: 'runWorklet' }> = {
      type: 'runWorklet',
      runId,
      code,
      hash,
      closureId,
      closureSpec,
      argsSpec,
      awaitReply,
    }
    if (typeof opts.eventTimestamp === 'number') {
      message.eventTimestamp = opts.eventTimestamp
    }
    this.channel.send(message)

    return promise
  }

  /** returns true if a SharedValue with this id has a slot in the shared array */
  hasSlot(id: number): boolean {
    return id >= SAB_HEADER_FLOATS && id < this.capacity
  }

  /**
   * Register a React-local callback so it can be invoked by UI-side worklets via
   * runOnJS. Returns a wrapper function that:
   *   - when called locally on react, just runs `fn` (so existing call sites that
   *     don't ship to ui still work)
   *   - when serialized via serializeValue, becomes a kind:'jsCallback' spec
   *     carrying the registration id
   *
   * Memoizes per source fn so the same `runOnJS(fn)` call returns a stable wrapper
   * across renders, keeping the id space small.
   */
  registerJSCallback<T extends (...args: unknown[]) => unknown>(fn: T): T {
    const existing = this.jsCallbackByFn.get(fn as unknown as object)
    if (existing) return existing.wrapper as unknown as T
    const id = this.nextJsCallbackId++
    this.jsCallbacks.set(id, fn as (...args: unknown[]) => unknown)
    const wrapper = ((...args: unknown[]) => fn.apply(null, args)) as T & {
      __rngpui_jsCallback?: number
    }
    wrapper.__rngpui_jsCallback = id
    this.jsCallbackByFn.set(fn as unknown as object, {
      id,
      wrapper: wrapper as unknown as (...args: unknown[]) => unknown,
    })
    return wrapper as unknown as T
  }

  private serializeValueForDispatch(value: unknown, path = '$'): ValueSpec {
    return serializeValueInternal(
      value,
      {
        registerPlainFunction: (fn) => this.serializeRegisteredJSCallback(fn),
        serializeWorkletFunction: (fn) => this.serializeWorkletFunctionForDispatch(fn),
        serializeAnimatedRef: (ref) => this.serializeAnimatedRefForDispatch(ref),
      },
      undefined,
      0,
      path,
    )
  }

  private serializeClosureForDispatch(
    closure: Record<string, unknown>,
    owner?: string,
  ): ClosureSpec {
    const out: ClosureSpec = {}
    for (const key of Object.keys(closure)) {
      try {
        out[key] = this.serializeValueForDispatch(closure[key], `$.${key}`)
      } catch (err) {
        const suffix = owner ? ` while serializing ${owner} closure key "${key}"` : ''
        throw new Error(`${(err as Error).message}${suffix}`, { cause: err })
      }
    }
    return out
  }

  private serializeWorkletFunctionForDispatch(fn: WorkletFn): WorkletFunctionSpec {
    const code = fn.__initData?.code
    const hash = fn.__workletHash
    if (!code || typeof hash !== 'number') {
      throw new Error(
        'worklet-runtime: function is not a worklet (missing __initData/__workletHash). ' +
          'did the babel reanimated/worklets plugin run on this file?',
      )
    }

    const closure = fn.__closure ?? {}
    const key = fn as unknown as object
    const cached = this.serializedWorklets.get(key)
    if (
      cached &&
      cached.code === code &&
      cached.hash === hash &&
      cached.closure === closure
    ) {
      return cached.spec
    }

    const spec: WorkletFunctionSpec = {
      kind: 'fn',
      code,
      hash,
      closureId: this.nextSerializedClosureId++,
      closureSpec: this.serializeClosureForDispatch(closure, describeWorklet(fn)),
    }
    this.serializedWorklets.set(key, { code, hash, closure, spec })
    return spec
  }

  private serializeRegisteredJSCallback(
    fn: (...args: unknown[]) => unknown,
  ): Extract<ValueSpec, { kind: 'jsCallback' }> {
    const wrapped = this.registerJSCallback(fn) as ((...args: unknown[]) => unknown) & {
      __rngpui_jsCallback?: number
    }
    const id = wrapped.__rngpui_jsCallback
    if (typeof id !== 'number') {
      throw new Error('worklet-runtime: failed to register js callback')
    }
    return { kind: 'jsCallback', id }
  }

  /**
   * Send a `runJSCallback` to the peer. UI-side bindRemoteJSCallback uses this
   * when a deserialized callback wrapper is invoked.
   */
  postJSCallback(id: number, args: unknown[]): void {
    if (!this.channel.hasPeer()) {
      console.warn('[worklet-runtime] postJSCallback with no peer')
      return
    }
    this.statRunJSCallbackSent++
    this.channel.send({
      type: 'runJSCallback',
      callbackId: id,
      argsSpec: args.map((a) => serializeValue(a)),
    })
  }

  private handleRunWorklet(msg: Extract<WorkletMessage, { type: 'runWorklet' }>) {
    let fn = this.workletCache.get(msg.hash)
    if (!fn) {
      try {
        fn = evalWorkletCode(msg.code)
        this.workletCache.set(msg.hash, fn)
      } catch (err) {
        if (msg.awaitReply) {
          this.channel.send({
            type: 'workletReply',
            runId: msg.runId,
            ok: false,
            error: `eval failed: ${(err as Error).message}`,
          })
        } else {
          console.error('[worklet-runtime] eval failed', err)
          this.channel.send({
            type: 'workletDone',
            runId: msg.runId,
            ok: false,
            error: `eval failed: ${(err as Error).message}`,
          })
        }
        return
      }
    }
    let result: unknown
    try {
      const closure = this.getMaterializedClosure(msg.hash, msg.closureId, msg.closureSpec)
      const args = msg.argsSpec.map((spec) => this.deserializeValue(spec))
      // attach closure as expected by the babel transform: the fn body reads
      // `this.__closure.foo` for any captured variable, so attach the closure and
      // call with fn as `this`. the evaled fn is SHARED per workletHash, so this
      // attach must happen on EVERY dispatch — two different closures of the same
      // worklet would otherwise read each other's state.
      ;(fn as WorkletFn).__closure = closure as Record<string, unknown>
      // recursive worklets carry `const NAME = this._recur` at the top of their
      // body (babel-plugin-worklets emits it whenever the function
      // self-references). bind `_recur` to fn-with-fn-as-this so that when the body
      // passes `_recur` as a callback to Array.some / map / etc., the inner
      // invocation still has `this === fn` and the closure access keeps working.
      ;(fn as WorkletFn & { _recur?: unknown })._recur = fn.bind(fn)
      result = runWithEventFrameTimestamp(msg.eventTimestamp, () =>
        runWithWorkletFlag(() => fn.apply(fn, args)),
      )
    } catch (err) {
      if (msg.awaitReply) {
        this.channel.send({
          type: 'workletReply',
          runId: msg.runId,
          ok: false,
          error: `worklet threw: ${(err as Error).message}`,
        })
      } else {
        console.error('[worklet-runtime] worklet threw', err)
        this.channel.send({
          type: 'workletDone',
          runId: msg.runId,
          ok: false,
          error: `worklet threw: ${(err as Error).message}`,
        })
      }
      return
    }
    if (msg.awaitReply) {
      this.channel.send({
        type: 'workletReply',
        runId: msg.runId,
        ok: true,
        returnValueSpec: serializeValue(result),
      })
    } else {
      this.channel.send({ type: 'workletDone', runId: msg.runId, ok: true })
    }
  }

  /**
   * Re-hydrate a closure spec into an object the worklet body can read via
   * `this.__closure`. SV refs become live SharedValue proxies bound to this
   * runtime's slot view; nested fn specs become callable worklets that themselves
   * dispatch back to the peer.
   */
  deserializeClosure(spec: ClosureSpec): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(spec)) {
      out[key] = this.deserializeValue(spec[key])
    }
    return out
  }

  private getMaterializedClosure(
    hash: number,
    closureId: number,
    spec: ClosureSpec,
  ): Record<string, unknown> {
    if (closureId > 0) {
      const cacheKey = getMaterializedClosureCacheKey(hash, closureId)
      const cached = this.materializedClosureCache.get(cacheKey)
      if (cached) {
        this.statClosureCacheHits++
        return cached
      }
      this.statClosureCacheMisses++
      const closure = this.deserializeClosure(spec)
      this.materializedClosureCache.set(cacheKey, closure)
      return closure
    }
    this.statClosureCacheMisses++
    return this.deserializeClosure(spec)
  }

  deserializeValue(spec: ValueSpec): unknown {
    switch (spec.kind) {
      case 'sv':
        return this.bindSharedValueProxy(spec.id)
      case 'svObject':
        return this.bindObjectSharedValueProxy(spec.id)
      case 'svDetached':
        return bindDetachedObjectSharedValue(spec.value)
      case 'animation': {
        const factories = (
          globalThis as {
            __rngpuiReanimatedAnimationFactories?: Record<string, (...args: unknown[]) => unknown>
          }
        ).__rngpuiReanimatedAnimationFactories
        const factory = factories?.[spec.type]
        if (typeof factory !== 'function') {
          throw new Error(
            `[worklet-runtime] no animation factory '${spec.type}' on this runtime (ui-entry registers them)`,
          )
        }
        return factory(...spec.args.map((arg) => this.deserializeValue(arg)))
      }
      case 'plain':
        return spec.value
      case 'builtin':
        return this.bindBuiltin(spec.name)
      case 'fn':
        return this.bindRemoteWorklet(spec)
      case 'initializer': {
        const init = this.bindRemoteWorklet(spec.init)
        return init()
      }
      case 'animatedRef':
        return makeRemoteAnimatedRef(spec.viewTag)
      case 'animatedRefSlot':
        return this.bindRemoteAnimatedRefSlot(spec.slotId)
      case 'jsCallback':
        return this.bindRemoteJSCallback(spec.id)
      case 'undef':
        return undefined
      case 'array':
        return spec.items.map((item) => this.deserializeValue(item))
      case 'object': {
        const out: Record<string, unknown> = {}
        for (const [key, value] of spec.entries) {
          out[key] = this.deserializeValue(value)
        }
        return out
      }
      case 'shareableRef': {
        // upstream serializableMappingCache contract: the SAME shareable resolves
        // to the SAME peer-side object on every (re-)ship, so the mapper's
        // accumulated state survives stopMapper/startMapper.
        const existing = this.shareableCache.get(spec.id)
        if (existing) return existing
        const out: Record<string, unknown> = {}
        for (const [key, value] of spec.snapshot) {
          out[key] = this.deserializeValue(value)
        }
        this.shareableCache.set(spec.id, out)
        return out
      }
    }
  }

  /**
   * Bind a peer-side js-callback id to a local function that ships args back
   * across the channel. Used on the UI runtime for runOnJS-tagged callbacks
   * captured in the closure.
   */
  private bindRemoteJSCallback(id: number): (...args: unknown[]) => void {
    return (...args: unknown[]) => {
      this.postJSCallback(id, args)
    }
  }

  private bindBuiltin(name: string): unknown {
    const registered = getWorkletBuiltinRegistry().get(name)
    if (registered) return registered

    if (name === 'runOnJS') {
      return <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
    }

    if (name === 'runOnUI' || name === 'scheduleOnUI') {
      return <T extends (...args: unknown[]) => unknown>(fn: T, ...bound: unknown[]) =>
        ((...args: unknown[]) => {
          if (typeof fn !== 'function') return undefined
          return fn.apply(fn, [...bound, ...args])
        }) as T
    }

    if (name === 'scheduleOnRN') {
      return <T extends (...args: unknown[]) => unknown>(fn: T, ...args: unknown[]) => {
        queueMicrotask(() => {
          if (typeof fn === 'function') fn(...args)
        })
      }
    }

    if (
      name === 'withTiming' ||
      name === 'withSpring' ||
      name === 'withDecay' ||
      name === 'withDelay' ||
      name === 'withRepeat' ||
      name === 'withSequence' ||
      name === 'withClamp'
    ) {
      return getReanimatedAnimationFactory(name)
    }

    return undefined
  }

  /**
   * A SharedValue proxy on the receiving side: reads/writes route through the slot,
   * and sets fan out to listeners. the proxy intentionally matches the same minimal
   * shape the worklet body expects (.value getter/setter, .get(), .set()) so
   * worklets authored against the real SharedValue API run unmodified here.
   */
  private bindSharedValueProxy(id: number): SharedValueProxy {
    const cached = this.svProxyCache.get(id)
    if (cached) return cached
    // a boolean shared value is stored Float64 0/1; restore the boolean type on
    // read so a worklet sees `false`/`true` (real reanimated semantics), not
    // `0`/`1`. captured once — proxies are cached per slot id.
    const isBool = this.boolSlots.has(id)
    const readSlot = (): number | boolean => {
      const raw = this.readSlot(id)
      return isBool ? raw !== 0 : raw
    }
    const writeSlot = (v: number | boolean) => {
      // this proxy represents a shared value captured by a worklet running on the
      // peer runtime. primitive slots live in the shared array, so writing here
      // already makes the new value visible to the owning runtime. real reanimated
      // does not bounce every UI-thread animation tick back into the JS React
      // tree; doing so makes UI-side timing loops produce React commits on every
      // frame. keep the local UI-side mapper fan-out, but skip the redundant peer
      // notification.
      this.writeSlot(id, v, true)
    }
    const subscribe = (fn: (value: number) => void) => this.subscribeSlot(id, fn)
    // upstream's mapper system addListener(mapperId, fn) and
    // removeListener(mapperId) when the mapper stops. upstream replaces an existing
    // listener for the same id on re-add. mirror that here so mappers don't leak
    // subscriptions across remounts.
    const unsubscribers = new Map<number, () => void>()
    const proxy: SharedValueProxy = {
      _id: id,
      // upstream's `isSharedValue` (and downstream `extractInputs` in mappers.ts)
      // gates on this exact prop. without it, the proxy looks like a plain object
      // and the mapper-input traversal walks into `Object.getPrototypeOf` of itself
      // and crashes on the next recursion layer.
      _isReanimatedSharedValue: true,
      get value() {
        return readSlot()
      },
      set value(v: number | boolean) {
        setSharedValueThroughReanimated(proxy, v, writeSlot)
      },
      get(): number | boolean {
        return readSlot()
      },
      set(v: number | boolean | (() => number | boolean)): void {
        const resolved = typeof v === 'function' ? (v as () => number | boolean)() : v
        setSharedValueThroughReanimated(proxy, resolved, writeSlot)
      },
      modify(
        modifier: (value: number | boolean) => number | boolean,
        forceUpdate = true,
      ): void {
        const next = modifier !== undefined ? modifier(readSlot()) : readSlot()
        setSharedValueThroughReanimated(proxy, next, writeSlot, forceUpdate)
      },
      addListener(listenerId: number, fn: (value: number) => void): void {
        const prev = unsubscribers.get(listenerId)
        if (prev) prev()
        unsubscribers.set(listenerId, subscribe(fn))
      },
      removeListener(listenerId: number): void {
        const off = unsubscribers.get(listenerId)
        if (off) {
          off()
          unsubscribers.delete(listenerId)
        }
      },
      get _value() {
        return readSlot()
      },
      set _value(v: number | boolean) {
        writeSlot(v)
      },
      _animation: null,
      setDirty() {},
    } as SharedValueProxy
    this.svProxyCache.set(id, proxy)
    return proxy
  }

  /**
   * Object-SV equivalent of bindSharedValueProxy. Reads return the local Map entry;
   * writes update local + queue a peer notification. Identity isn't preserved across
   * runtimes (the value is structured-cloned across the channel), but each side's Map
   * holds the latest snapshot so .value always returns the most recent post-flush
   * state.
   */
  private bindObjectSharedValueProxy(id: number): ObjectSharedValueProxy {
    const cached = this.svObjectProxyCache.get(id)
    if (cached) return cached
    const readSlot = () => this.readObjectSlot(id)
    const writeSlot = (v: unknown) => {
      this.writeObjectSlot(id, v)
    }
    const subscribe = (fn: (value: unknown) => void) => this.subscribeObjectSlot(id, fn)
    const unsubscribers = new Map<number, () => void>()
    const proxy: ObjectSharedValueProxy = {
      _id: id,
      _isReanimatedSharedValue: true,
      get value() {
        return readSlot()
      },
      set value(v: unknown) {
        writeSlot(v)
      },
      get(): unknown {
        return readSlot()
      },
      set(v: unknown): void {
        const resolved =
          typeof v === 'function' ? (v as (c: unknown) => unknown)(readSlot()) : v
        writeSlot(resolved)
      },
      modify(modifier: (value: unknown) => unknown, _forceUpdate = true): void {
        writeSlot(modifier !== undefined ? modifier(readSlot()) : readSlot())
      },
      addListener(listenerId: number, fn: (value: unknown) => void): void {
        const prev = unsubscribers.get(listenerId)
        if (prev) prev()
        unsubscribers.set(listenerId, subscribe(fn))
      },
      removeListener(listenerId: number): void {
        const off = unsubscribers.get(listenerId)
        if (off) {
          off()
          unsubscribers.delete(listenerId)
        }
      },
    }
    markObjectSV(proxy)
    this.svObjectProxyCache.set(id, proxy)
    return proxy
  }

  private bindRemoteAnimatedRefSlot(slotId: number): AnimatedRefLike {
    const readTag = () => {
      const tag = this.readSlot(slotId)
      return isValidViewTag(tag) ? tag : -1
    }
    const wrapper = () => {
      const tag = readTag()
      return isValidViewTag(tag) ? { __viewTag: tag } : -1
    }
    const ref = wrapper as AnimatedRefLike
    Object.defineProperty(ref, 'current', {
      get: () => wrapper(),
      configurable: true,
    })
    ref.getTag = readTag
    ref.observe = (observer) => {
      let cleanup = observer(isValidViewTag(readTag()) ? readTag() : null)
      const unsubscribe = this.subscribeSlot(slotId, (value) => {
        if (typeof cleanup === 'function') cleanup()
        cleanup = observer(isValidViewTag(value) ? value : null)
      })
      return () => {
        unsubscribe()
        if (typeof cleanup === 'function') cleanup()
      }
    }
    return ref
  }

  private serializeAnimatedRefForDispatch(value: unknown): ValueSpec | null {
    if (!isAnimatedRefLike(value)) return null
    if (typeof value.observe !== 'function') {
      const viewTag = getAnimatedRefViewTag(value)
      return viewTag === null ? null : { kind: 'animatedRef', viewTag }
    }
    const key = value as unknown as object
    const existing = this.animatedRefSlots.get(key)
    if (existing) return { kind: 'animatedRefSlot', slotId: existing.slotId }

    const initialTag = getAnimatedRefViewTag(value) ?? -1
    const slotId = this.allocSharedValueSlot(initialTag)
    const entry: { slotId: number; unsubscribe?: () => void } = { slotId }
    this.animatedRefSlots.set(key, entry)
    try {
      const unsubscribe = value.observe((next) => {
        const tag = getSerializableViewTag(next) ?? (isValidViewTag(next) ? next : -1)
        this.writeSlot(slotId, tag)
        return undefined
      })
      if (typeof unsubscribe === 'function') {
        entry.unsubscribe = () => {
          unsubscribe()
        }
      }
    } catch {
      this.writeSlot(slotId, initialTag)
    }
    return { kind: 'animatedRefSlot', slotId }
  }

  /**
   * Bind a remote worklet that lived in the original closure as a callable.
   * Calling it dispatches back through this runtime to the peer where the worklet's
   * home runtime can execute it. This is how runOnJS-from-ui round-trips: the
   * closure had a runOnJS-wrapped worklet, we call it, we ship it back across the
   * channel.
   */
  private bindRemoteWorklet(spec: Extract<ValueSpec, { kind: 'fn' }>): WorkletFn {
    const cacheKey =
      spec.closureId > 0
        ? getMaterializedClosureCacheKey(spec.hash, spec.closureId)
        : null
    if (cacheKey) {
      const cached = this.remoteWorkletCache.get(cacheKey)
      if (cached) return cached
    }
    // local materialization so we can call it locally if needed (e.g. when the
    // channel is one-way for this hop). cache by hash to share fns.
    let local = this.workletCache.get(spec.hash)
    if (!local) {
      local = evalWorkletCode(spec.code)
      this.workletCache.set(spec.hash, local)
    }
    // deserialize the closure ONCE and reuse it for every call. upstream
    // reanimated ships a worklet's closure to the UI runtime a single time; the
    // worklet then runs repeatedly against that same closure. two properties
    // depend on this:
    //   - SharedValue proxies stay live regardless — they read the slot /
    //     object-slot on every `.value` access, so a stable proxy is always
    //     current.
    //   - stateful captured objects persist their mutations across runs. a
    //     reanimated mapper's `remoteState` (a `makeShareable` record holding
    //     `{last, animations, …}`) is mutated every frame; the mapper relies on
    //     reading back its own previous-frame state.
    // re-deserializing per call rebuilt `remoteState` fresh every frame —
    // `animations`/`last` reset to their initial values — which destroyed
    // animation continuity (springs glitched, never settled) and rebuilt the
    // entire closure graph on every animation/scroll frame. bind `_recur` once for
    // the same reason (see handleRunWorklet — recursive worklets read `this._recur`).
    let closure: Record<string, unknown> | null = null
    const recur = local.bind(local)
    const wrapped = ((...args: unknown[]) => {
      if (!closure) {
        closure = this.deserializeClosure(spec.closureSpec) as Record<string, unknown>
      }
      // the evaled fn is SHARED per workletHash — re-attach this wrapper's closure
      // on every call (another closure of the same worklet may have run since).
      ;(local as WorkletFn).__closure = closure
      ;(local as WorkletFn & { _recur?: unknown })._recur = recur
      return runWithWorkletFlag(() => local!.apply(local, args))
    }) as WorkletFn
    wrapped.__initData = { code: spec.code }
    wrapped.__workletHash = spec.hash
    wrapped.__closure = {}
    if (cacheKey) this.remoteWorkletCache.set(cacheKey, wrapped)
    return wrapped
  }
}

function runWithWorkletFlag<T>(fn: () => T): T {
  const g = globalThis as { _WORKLET?: boolean }
  const previous = g._WORKLET
  g._WORKLET = true
  try {
    return fn()
  } finally {
    g._WORKLET = previous
  }
}

function runWithEventFrameTimestamp<T>(timestamp: number | undefined, fn: () => T): T {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return fn()
  }
  const g = globalThis as {
    __frameTimestamp?: number
    __flushAnimationFrame?: (timestamp: number) => void
  }
  const previous = g.__frameTimestamp
  g.__frameTimestamp = timestamp
  try {
    const result = fn()
    g.__flushAnimationFrame?.(timestamp)
    return result
  } finally {
    g.__frameTimestamp = previous
  }
}

export interface SharedValueProxy {
  _id: number
  _isReanimatedSharedValue: true
  // booleans read back as booleans (boolean slots are stored Float64 0/1 but reads
  // restore the type — see bindSharedValueProxy), so a worklet sees the same value
  // real reanimated would.
  value: number | boolean
  _value: number | boolean
  _animation: unknown
  get(): number | boolean
  set(v: number | boolean | (() => number | boolean)): void
  modify(
    modifier: (value: number | boolean) => number | boolean,
    forceUpdate?: boolean,
  ): void
  addListener(id: number, fn: (value: number) => void): void
  removeListener(id: number): void
  setDirty(dirty: boolean): void
}

// matches upstream's SharedValue shape for non-primitive values. the hidden
// OBJECT_SV_BRAND lets serializer distinguish object SVs from primitive SVs (which
// can also have non-number `.value` mid-animation when an animation object is
// briefly assigned).
export interface ObjectSharedValueProxy {
  _id: number
  _isReanimatedSharedValue: true
  value: unknown
  get(): unknown
  set(v: unknown): void
  modify(modifier: (value: unknown) => unknown, forceUpdate?: boolean): void
  addListener(id: number, fn: (value: unknown) => void): void
  removeListener(id: number): void
}

export interface WorkletFn {
  __closure?: Record<string, unknown>
  __workletHash?: number
  __initData?: { code?: string; location?: string; sourceMap?: string }
  (...args: unknown[]): unknown
}

// ---------------------------------------------------------------------
// serialization helpers (closure-side; react typically calls these, ui calls them
// on reply paths)
// ---------------------------------------------------------------------

// stable across the (single-realm) react context: the worklets stub `makeShareable`
// stamps source records with this key; the serializer reads it to emit
// `shareableRef`. Symbol.for keeps it identical between the compat stub and the
// runtime without a cross-module import.
export const SHAREABLE_ID_KEY = Symbol.for('rngpui.shareableId')

export function serializeValue(value: unknown): ValueSpec {
  return serializeValueInternal(value)
}

interface SerializeOptions {
  registerPlainFunction?: (
    fn: (...args: unknown[]) => unknown,
  ) => Extract<ValueSpec, { kind: 'jsCallback' }>
  serializeWorkletFunction?: (fn: WorkletFn) => WorkletFunctionSpec
  serializeAnimatedRef?: (value: unknown) => ValueSpec | null
}

function serializeWorkletFunctionValue(
  value: WorkletFn,
  opts: SerializeOptions | undefined,
  seen: WeakSet<object>,
  depth: number,
): WorkletFunctionSpec {
  if (opts?.serializeWorkletFunction) return opts.serializeWorkletFunction(value)
  return {
    kind: 'fn',
    code: value.__initData!.code!,
    hash: value.__workletHash!,
    closureId: 0,
    closureSpec: serializeClosureInternal(value.__closure ?? {}, opts, seen, depth + 1),
  }
}

function serializeValueInternal(
  value: unknown,
  opts?: SerializeOptions,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
  path = '$',
): ValueSpec {
  if (value === undefined) return { kind: 'undef' }
  const animatedRefSpec = opts?.serializeAnimatedRef?.(value)
  if (animatedRefSpec) return animatedRefSpec
  const animatedRefTag = getAnimatedRefViewTag(value)
  if (animatedRefTag !== null) {
    return { kind: 'animatedRef', viewTag: animatedRefTag }
  }
  const mapped = getSerializableMapping(value)
  if (mapped !== undefined && mapped !== value) {
    return serializeValueInternal(mapped, opts, seen, depth, path)
  }
  // SharedValue detection: real reanimated has _id + .value getter; our slot-backed
  // and object-backed proxies both have the same minimal shape. discriminate via
  // the `_isObjectSV` brand we plant when createShareable allocates an object slot,
  // so primitive vs object routing is unambiguous even when a primitive's `.value`
  // is briefly an animation object during a `withTiming` assignment.
  if (isObjectSharedValueLike(value)) {
    return { kind: 'svObject', id: value._id }
  }
  if (isSharedValueLike(value)) {
    return { kind: 'sv', id: value._id }
  }
  // a reanimated mutable that arrived WITHOUT an `_id`. createShareable's object
  // branch fell back to the local-only `decorated` object — the slot/object-slot
  // pool was exhausted under churn, or, in degraded contexts, the runtime wasn't
  // wired. upstream's invariant is that a SharedValue is ALWAYS shippable to the UI
  // runtime; rngpui's EAGER wiring (in createShareable) can fail, so restore the
  // invariant here — the single cross-runtime chokepoint — by wiring it LAZILY at
  // ship time, exactly like upstream reanimated's makeShareableCloneRecursive. the
  // wirer mutates `value` in place: it gains `_id` + the object-SV brand, so every
  // subsequent ship takes the normal isObjectSharedValueLike path and react
  // `.value =` writes propagate to the peer slot. without this the mutable would
  // deep-clone into a plain object below and the peer worklet would throw
  // `configRef.get is not a function`.
  if (isUnwiredReanimatedMutable(value)) {
    const wiredId = getLazyObjectShareableWirer()?.(value) ?? null
    if (typeof wiredId === 'number') {
      return { kind: 'svObject', id: wiredId }
    }
    // wiring unavailable or the pool is still exhausted: ship a detached snapshot so
    // the peer worklet still gets a `.get()`-bearing object.
    return { kind: 'svDetached', value: structuredCloneSafe(value.value) }
  }
  if (isJSCallback(value)) {
    return { kind: 'jsCallback', id: value.__rngpui_jsCallback }
  }
  const builtin = getWorkletBuiltinName(value)
  if (builtin) {
    return { kind: 'builtin', name: builtin }
  }
  if (isWorkletFn(value)) {
    return serializeWorkletFunctionValue(value, opts, seen, depth)
  }
  if (typeof value === 'function' && opts?.registerPlainFunction) {
    return opts.registerPlainFunction(value as (...args: unknown[]) => unknown)
  }
  // arrays — recurse so nested SharedValues / worklet refs survive. upstream
  // reanimated ships SharedValue arrays as `inputs` to startMapper(); a shallow
  // `structuredClone` would strip the `_id` wiring and the UI-side mapper would
  // crash extracting inputs.
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error(`worklet-runtime: cyclic array in closure at ${path}`)
    }
    seen.add(value)
    try {
      return {
        kind: 'array',
        items: value.map((v, index) =>
          serializeValueInternal(v, opts, seen, depth + 1, `${path}[${index}]`),
        ),
      }
    } finally {
      seen.delete(value)
    }
  }
  const viewTag = getSerializableViewTag(value)
  if (viewTag !== null) {
    return { kind: 'plain', value: { __viewTag: viewTag } }
  }
  const animationDescriptor = readAnimationDescriptorSpec(value)
  if (animationDescriptor) {
    return {
      kind: 'animation',
      type: animationDescriptor.type,
      args: animationDescriptor.args.map((arg, i) =>
        serializeValueInternal(arg, opts, seen, depth + 1, `${path}.<anim:${animationDescriptor.type}:${i}>`),
      ),
    }
  }
  if (isSerializableInitializer(value)) {
    return {
      kind: 'initializer',
      init: serializeWorkletFunctionValue(value.__init, opts, seen, depth),
    }
  }
  // plain objects — recurse the same way for {...keyboardConfig} style closures
  // that mix primitives with SharedValues. only "plain" objects (Object.prototype)
  // get recursed; class instances and exotic objects fall through to
  // structuredClone where their identity may be lost (acceptable: those callers
  // already sit outside upstream's worklet contract).
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    if (seen.has(value)) {
      throw new Error(`worklet-runtime: cyclic object in closure at ${path}`)
    }
    seen.add(value)
    const entries: Array<[string, ValueSpec]> = []
    try {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (key === 'shadowNodeWrapper') {
          // on rngpui, getShadowNodeWrapperFromRef returns the BARE NUMERIC id
          // (the reconciler's __internalInstanceHandle.stateNode.node IS the
          // globalId — see reconciler.ts); object shapes come from other paths.
          const raw = (value as Record<string, unknown>)[key]
          const tag = isValidViewTag(raw) ? raw : getSerializableViewTag(raw)
          entries.push([
            key,
            tag === null
              ? { kind: 'plain', value: null }
              : { kind: 'plain', value: { __viewTag: tag } },
          ])
          continue
        }
        entries.push([
          key,
          serializeValueInternal(
            (value as Record<string, unknown>)[key],
            opts,
            seen,
            depth + 1,
            `${path}.${key}`,
          ),
        ])
      }
      // `makeShareable`-stamped record: emit a stable ref so re-ships resolve to the
      // SAME persistent peer-side object (upstream serializableMappingCache
      // contract). first materialization still uses the deep entries above; later
      // ships ignore them. SHAREABLE_ID_KEY is non-enumerable so it never appears in
      // `entries`.
      const shareableId = (value as Record<symbol, unknown>)[SHAREABLE_ID_KEY]
      if (typeof shareableId === 'number') {
        return { kind: 'shareableRef', id: shareableId, snapshot: entries }
      }
      return { kind: 'object', entries }
    } finally {
      seen.delete(value)
    }
  }
  // primitives / typed arrays / Maps / etc. — structured-clone-safe.
  return { kind: 'plain', value: structuredCloneSafe(value) }
}

export function serializeClosure(closure: Record<string, unknown>): ClosureSpec {
  return serializeClosureInternal(closure)
}

function serializeClosureInternal(
  closure: Record<string, unknown>,
  opts?: SerializeOptions,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
  path = '$',
): ClosureSpec {
  const out: ClosureSpec = {}
  for (const key of Object.keys(closure)) {
    out[key] = serializeValueInternal(closure[key], opts, seen, depth + 1, `${path}.${key}`)
  }
  return out
}

function isSharedValueLike(v: unknown): v is { _id: number; value: number } {
  if (!v || typeof v !== 'object') return false
  const obj = v as { _id?: unknown; value?: unknown }
  return (
    typeof obj._id === 'number' && obj._id >= SAB_HEADER_FLOATS && obj._id < OBJECT_ID_BASE
  )
}

const RNGPUI_ANIMATION_DESCRIPTOR = Symbol.for('rngpui.reanimatedAnimationDescriptor')

/** read the {type, args} stamp reanimated-host.ts places on animation objects. */
function readAnimationDescriptorSpec(value: unknown): { type: string; args: unknown[] } | null {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null
  const descriptor = (value as { [RNGPUI_ANIMATION_DESCRIPTOR]?: unknown })[RNGPUI_ANIMATION_DESCRIPTOR]
  if (!descriptor || typeof descriptor !== 'object') return null
  const type = (descriptor as { type?: unknown }).type
  const args = (descriptor as { args?: unknown }).args
  if (typeof type !== 'string' || !Array.isArray(args)) return null
  return { type, args }
}

function getSerializableViewTag(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): number | null {
  if (!value || typeof value !== 'object') return null
  if (seen.has(value)) return null
  seen.add(value)
  const direct = (value as { __viewTag?: unknown }).__viewTag
  if (isValidViewTag(direct)) return direct
  const nativeTag = (value as { __nativeTag?: unknown }).__nativeTag
  if (isValidViewTag(nativeTag)) return nativeTag
  const legacyNativeTag = (value as { _nativeTag?: unknown })._nativeTag
  if (isValidViewTag(legacyNativeTag)) return legacyNativeTag
  const nested = (value as { node?: { __viewTag?: unknown } }).node?.__viewTag
  if (isValidViewTag(nested)) return nested
  const stateNode = (
    value as {
      stateNode?: { node?: unknown }
    }
  ).stateNode?.node
  const stateNodeTag = getSerializableViewTag(stateNode, seen)
  if (stateNodeTag !== null) return stateNodeTag
  const internalNode = (
    value as {
      __internalInstanceHandle?: { stateNode?: { node?: unknown } }
    }
  ).__internalInstanceHandle?.stateNode?.node
  const internalNodeTag = getSerializableViewTag(internalNode, seen)
  if (internalNodeTag !== null) return internalNodeTag
  // rngpui: a reconciler Instance's `.id` IS the globalId rust keys on, so an
  // animated component ref resolves to its globalId here.
  const id = (value as { id?: unknown }).id
  if (isValidViewTag(id)) return id
  return null
}

interface AnimatedRefLike {
  (...args: unknown[]): unknown
  current?: unknown
  getTag?: () => unknown
  observe?: (observer: (tagOrWrapper: unknown) => unknown) => unknown
}

function isAnimatedRefLike(value: unknown): value is AnimatedRefLike {
  if (typeof value !== 'function') return false
  const ref = value as {
    current?: unknown
    getTag?: () => unknown
    observe?: unknown
  }
  return typeof ref.getTag === 'function' || typeof ref.observe === 'function'
}

function getAnimatedRefViewTag(value: unknown): number | null {
  if (!isAnimatedRefLike(value)) return null
  const ref = value
  const fromCurrent = getSerializableViewTag(ref.current)
  if (fromCurrent !== null) return fromCurrent
  try {
    const tag = ref.getTag?.()
    if (isValidViewTag(tag)) return tag
    const fromTagObject = getSerializableViewTag(tag)
    if (fromTagObject !== null) return fromTagObject
  } catch {}
  try {
    const tag = ref()
    if (isValidViewTag(tag)) return tag
    const fromTagObject = getSerializableViewTag(tag)
    if (fromTagObject !== null) return fromTagObject
  } catch {}
  return null
}

function isValidViewTag(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function makeRemoteAnimatedRef(viewTag: number): (() => { __viewTag: number }) & {
  current: { __viewTag: number }
  getTag: () => number
} {
  const wrapper = { __viewTag: viewTag }
  const ref = (() => wrapper) as (() => { __viewTag: number }) & {
    current: { __viewTag: number }
    getTag: () => number
  }
  ref.current = wrapper
  ref.getTag = () => viewTag
  return ref
}

function getReanimatedAnimationFactory(name: string): (...args: unknown[]) => unknown {
  const factories = (globalThis as Record<string, unknown>)[REANIMATED_ANIMATION_FACTORIES]
  const factory =
    factories && typeof factories === 'object'
      ? (factories as Record<string, unknown>)[name]
      : undefined
  if (typeof factory !== 'function') {
    throw new Error(
      `[worklet-runtime] missing reanimated animation factory "${name}" on this runtime`,
    )
  }
  return factory as (...args: unknown[]) => unknown
}

function getReanimatedValueSetter():
  | ((mutable: SharedValueProxy, value: unknown, forceUpdate?: boolean) => void)
  | null {
  const setter = (globalThis as Record<string, unknown>)[REANIMATED_VALUE_SETTER]
  return typeof setter === 'function'
    ? (setter as (mutable: SharedValueProxy, value: unknown, forceUpdate?: boolean) => void)
    : null
}

function isReanimatedAnimationValue(value: unknown): boolean {
  return (
    typeof value === 'function' ||
    (!!value &&
      typeof value === 'object' &&
      typeof (value as { onFrame?: unknown }).onFrame === 'function')
  )
}

function setSharedValueThroughReanimated(
  mutable: SharedValueProxy,
  value: unknown,
  writeSlot: (value: number) => void,
  forceUpdate = false,
): void {
  const setter = getReanimatedValueSetter()
  if (setter) {
    setter(mutable, value, forceUpdate)
    return
  }
  if (isReanimatedAnimationValue(value)) {
    throw new Error('[worklet-runtime] reanimated valueSetter is not installed')
  }
  writeSlot(value as number)
}

// brand planted by `createShareable` (worklets stub) when an object SV is
// allocated. avoids relying on .value being non-number (the briefly-an-animation-
// object case during withTiming would otherwise misclassify a primitive SV as
// object).
const OBJECT_SV_BRAND = Symbol.for('rngpui.objectSV')

export function markObjectSV(target: object): void {
  ;(target as { [k: symbol]: boolean })[OBJECT_SV_BRAND] = true
}

function isObjectSharedValueLike(v: unknown): v is { _id: number; value: unknown } {
  if (!v || typeof v !== 'object') return false
  const obj = v as { _id?: unknown; [k: symbol]: unknown }
  return typeof obj._id === 'number' && obj[OBJECT_SV_BRAND] === true
}

// a reanimated mutable (createShareable's host-decorated SharedValue) that reached
// the serializer WITHOUT an `_id` — i.e. createShareable's object branch fell back
// to the local-only `decorated` object. recognized by the stable
// `_isReanimatedSharedValue` brand reanimated's host decorator plants (and
// createShareable preserves). see the lazy-wire branch in serializeValueInternal.
function isUnwiredReanimatedMutable(v: unknown): v is { value: unknown } {
  if (!v || typeof v !== 'object') return false
  const o = v as { _id?: unknown; _isReanimatedSharedValue?: unknown }
  return o._isReanimatedSharedValue === true && typeof o._id !== 'number'
}

// the worklets stub installs this so the runtime serializer can lazily wire a
// reanimated mutable into a real object slot at ship time (reusing the same
// wireObjectSharedValue logic createShareable uses, so the wiring lives in ONE
// place). returns the allocated slot id, or null when the runtime is unavailable /
// the pool is still exhausted.
const LAZY_OBJECT_SHAREABLE_WIRER = '__rngpui_wire_object_shareable'
type LazyObjectShareableWirer = (value: { value: unknown }) => number | null
function getLazyObjectShareableWirer(): LazyObjectShareableWirer | null {
  const fn = (globalThis as Record<string, unknown>)[LAZY_OBJECT_SHAREABLE_WIRER]
  return typeof fn === 'function' ? (fn as LazyObjectShareableWirer) : null
}

// rebuild a read-only object-SV proxy for a `svDetached` spec — a mutable that
// could not be slot-backed at ship time. `.get()`/`.value` return the shipped
// snapshot so the peer worklet runs instead of throwing; writes/listeners are
// no-ops (there is no slot to propagate through). NOT cached — each detached ship
// is its own one-shot snapshot.
//
// the proxy deliberately carries NO numeric `_id`: it keeps the
// `_isReanimatedSharedValue` brand so that if this detached proxy is itself
// captured in another worklet closure and re-shipped, `isUnwiredReanimatedMutable`
// re-catches it (its `_id` is not a number) and re-attempts real wiring (the slot
// pool may have recovered) or re-ships as another svDetached snapshot — so
// `.get()` survives every hop. a numeric `_id` here would fall through every SV
// guard on re-ship and deep-clone `.get()` away.
function bindDetachedObjectSharedValue(
  snapshot: unknown,
): Omit<ObjectSharedValueProxy, '_id'> {
  return {
    _isReanimatedSharedValue: true,
    get value() {
      return snapshot
    },
    set value(_v: unknown) {},
    get(): unknown {
      return snapshot
    },
    set(_v: unknown): void {},
    modify(_modifier: (value: unknown) => unknown, _forceUpdate = true): void {},
    addListener(_listenerId: number, _fn: (value: unknown) => void): void {},
    removeListener(_listenerId: number): void {},
  }
}

function isWorkletFn(v: unknown): v is WorkletFn {
  if (typeof v !== 'function') return false
  const f = v as WorkletFn
  return typeof f.__workletHash === 'number' && typeof f.__initData?.code === 'string'
}

function describeWorklet(fn: WorkletFn): string {
  const location = fn.__initData?.location
  const hash = typeof fn.__workletHash === 'number' ? fn.__workletHash : 'unknown'
  return location ? `worklet ${hash} at ${location}` : `worklet ${hash}`
}

function isSerializableInitializer(v: unknown): v is { __init: WorkletFn } {
  if (!v || typeof v !== 'object') return false
  if (Object.getPrototypeOf(v) !== Object.prototype) return false
  return isWorkletFn((v as { __init?: unknown }).__init)
}

function getWorkletBuiltinName(v: unknown): WorkletBuiltinName | null {
  return getSerializedBuiltinName(v)
}

function isJSCallback(
  v: unknown,
): v is ((...args: unknown[]) => unknown) & { __rngpui_jsCallback: number } {
  if (typeof v !== 'function') return false
  const f = v as { __rngpui_jsCallback?: unknown }
  return typeof f.__rngpui_jsCallback === 'number'
}

function structuredCloneSafe(value: unknown): unknown {
  // primitives pass through untouched — the overwhelmingly common case (closure
  // numbers / strings / booleans).
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' ? undefined : value
  }
  // NOT structuredClone: Hermes doesn't have it (it silently threw here and every
  // plain closure value crossed as undefined — the dead-animation bug), and using
  // it only-when-available would make bun tests semantically diverge from the
  // real runtime. The channel is JSON-string transport, so a JSON round-trip IS
  // the faithful clone for anything that can cross (drops functions/symbols,
  // plain-objectifies Maps/typed arrays — exactly what the wire would do).
  // cycles are pre-guarded by the caller's `seen` set; a throw (e.g. BigInt)
  // degrades to undefined — a clear gap rather than a shared live reference.
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return undefined
  }
}

// sanitize before send: any function or symbol nested in an object-SV payload
// would otherwise throw during JSON/structured encoding and tear down the whole
// batch. also shrink descriptor shadowNodeWrappers to `{__viewTag}` — those
// wrappers are live engine nodes full of methods / parent refs, while the peer
// only needs the tag to route _updateProps.
//
// object SVs are a protocol boundary, not a general-purpose object tunnel.
// reanimated uses them for shallow layout records and viewDescriptors; shipping
// arbitrary app/runtime graphs is both unnecessary and unsafe because the encoder
// can recurse deeply enough to overflow.
const MAX_PEER_OBJECT_DEPTH = 24
const MAX_PEER_ARRAY_ITEMS = 4096
const MAX_PEER_OBJECT_KEYS = 256

interface SanitizeState {
  seen: WeakMap<object, unknown>
  active: WeakSet<object>
  depth: number
}

function isPeerPrimitive(value: unknown): boolean {
  const t = typeof value
  return (
    value === null || t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint'
  )
}

function childSanitizeState(state: SanitizeState): SanitizeState {
  return { seen: state.seen, active: state.active, depth: state.depth + 1 }
}

function sanitizeForPeer(
  value: unknown,
  state: SanitizeState = {
    seen: new WeakMap(),
    active: new WeakSet(),
    depth: 0,
  },
): unknown {
  if (value === null) return null
  const t = typeof value
  if (t === 'function' || t === 'symbol') return undefined
  if (t !== 'object') return value
  if (state.depth >= MAX_PEER_OBJECT_DEPTH) return undefined

  if (
    ArrayBuffer.isView(value as object) ||
    value instanceof ArrayBuffer ||
    value instanceof Date ||
    value instanceof RegExp ||
    (typeof Blob !== 'undefined' && value instanceof Blob) ||
    (typeof File !== 'undefined' && value instanceof File) ||
    (typeof ImageData !== 'undefined' && value instanceof ImageData)
  ) {
    return value
  }

  const objRef = value as object
  if (state.active.has(objRef)) return undefined
  if (state.seen.has(objRef)) return state.seen.get(objRef)

  if (Array.isArray(value)) {
    const out: unknown[] = []
    state.seen.set(objRef, out)
    state.active.add(objRef)
    const childState = childSanitizeState(state)
    const length = Math.min(value.length, MAX_PEER_ARRAY_ITEMS)
    for (let i = 0; i < length; i++) {
      const desc = Object.getOwnPropertyDescriptor(value, String(i))
      out.push(desc && 'value' in desc ? sanitizeForPeer(desc.value, childState) : undefined)
    }
    state.active.delete(objRef)
    return out
  }

  if (value instanceof Map) {
    const out = new Map<unknown, unknown>()
    state.seen.set(objRef, out)
    state.active.add(objRef)
    const childState = childSanitizeState(state)
    let count = 0
    for (const [k, v] of value) {
      if (count++ >= MAX_PEER_OBJECT_KEYS) break
      const tk = typeof k
      if (tk === 'function' || tk === 'symbol') continue
      out.set(sanitizeForPeer(k, childState), sanitizeForPeer(v, childState))
    }
    state.active.delete(objRef)
    return out
  }

  if (value instanceof Set) {
    const out = new Set<unknown>()
    state.seen.set(objRef, out)
    state.active.add(objRef)
    const childState = childSanitizeState(state)
    let count = 0
    for (const v of value) {
      if (count++ >= MAX_PEER_OBJECT_KEYS) break
      const tv = typeof v
      if (tv === 'function' || tv === 'symbol') continue
      out.add(sanitizeForPeer(v, childState))
    }
    state.active.delete(objRef)
    return out
  }

  const out: Record<string, unknown> = {}
  state.seen.set(objRef, out)
  state.active.add(objRef)
  const obj = value as Record<string, unknown>
  const wrapperDesc = Object.getOwnPropertyDescriptor(obj, 'shadowNodeWrapper')
  const wrapper =
    wrapperDesc && 'value' in wrapperDesc
      ? (wrapperDesc.value as { __viewTag?: number } | null | undefined)
      : null
  const wrapperTag =
    wrapper && typeof wrapper === 'object' && typeof wrapper.__viewTag === 'number'
      ? wrapper.__viewTag
      : null

  if (wrapperDesc) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (key === 'shadowNodeWrapper') {
        out.shadowNodeWrapper = wrapperTag !== null ? { __viewTag: wrapperTag } : null
        continue
      }
      const desc = Object.getOwnPropertyDescriptor(obj, key)
      if (!desc || !('value' in desc)) continue
      const v = desc.value
      if (isPeerPrimitive(v)) out[key] = v
    }
    state.active.delete(objRef)
    return out
  }

  const childState = childSanitizeState(state)
  const keys = Object.keys(value as Record<string, unknown>).slice(0, MAX_PEER_OBJECT_KEYS)
  for (const key of keys) {
    if (key === 'shadowNodeWrapper') {
      out.shadowNodeWrapper = wrapperTag !== null ? { __viewTag: wrapperTag } : null
      continue
    }
    const desc = Object.getOwnPropertyDescriptor(obj, key)
    if (!desc || !('value' in desc)) continue
    const v = desc.value
    const tv = typeof v
    if (tv === 'function' || tv === 'symbol') continue
    out[key] = sanitizeForPeer(v, childState)
  }
  state.active.delete(objRef)
  return out
}

// eval a worklet body. the babel transform emits the body as the entire function
// source, e.g. `function anonymous() { 'worklet'; ... }`. we build a fresh function
// via `(0, eval)(...)` rather than `new Function` because the source is already a
// complete function expression.
export function evalWorkletCode(code: string): (...args: unknown[]) => unknown {
  installWorkletGlobalAliases()
  if (typeof globalThis !== 'undefined') {
    const allowed = (globalThis as { __rngpui_worklet_eval_allowed?: boolean })
      .__rngpui_worklet_eval_allowed
    if (allowed === false) {
      throw new Error('worklet eval is disabled in this runtime')
    }
  }
  // wrap as `(<code>)` so an emitted `function name(...)` expression becomes a value
  // rather than a declaration.
  // biome-ignore lint/security/noGlobalEval: required for worklet eval
  const fn = (0, eval)(`(${code})`) as (...args: unknown[]) => unknown
  if (typeof fn !== 'function') {
    throw new Error('worklet eval did not produce a function')
  }
  return fn
}


// ---------------------------------------------------------------------
// shared-slot buffer (host-side helper). the rust host creates the buffer once and
// installs it in both runtimes as `globalThis.__rngpui_svSlots`. this helper is for
// tests / fallback contexts that need to build a compatible buffer themselves.
// ---------------------------------------------------------------------

export function createSharedValueBuffer(capacity: number = DEFAULT_CAPACITY): ArrayBuffer {
  const bytes = capacity * 8
  const buffer = new ArrayBuffer(bytes)
  const f = new Float64Array(buffer)
  f[0] = SAB_MAGIC
  f[1] = capacity
  // f[2], f[3] reserved.
  return buffer
}

// ---------------------------------------------------------------------
// per-runtime singleton
// ---------------------------------------------------------------------

// the singleton lives on globalThis so the compat stubs (which have no import
// dependency on the engine) can resolve it cross-module.
const GLOBAL_KEY = '__rngpui_worklet_runtime'
// the shared-slot ArrayBuffer the rust host installs in both runtimes.
const SHARED_SLOTS_KEY = '__rngpui_svSlots'

interface WorkletRuntimeGlobals {
  [GLOBAL_KEY]?: WorkletRuntime
}

export function setActiveWorkletRuntime(rt: WorkletRuntime): void {
  ;(globalThis as WorkletRuntimeGlobals)[GLOBAL_KEY] = rt
}

export function getWorkletRuntime(): WorkletRuntime | null {
  return (globalThis as WorkletRuntimeGlobals)[GLOBAL_KEY] ?? null
}

export function isWorkletRuntimeReady(): boolean {
  return getWorkletRuntime() !== null
}

function getSharedSlotsBuffer(): ArrayBuffer | null {
  const buf = (globalThis as Record<string, unknown>)[SHARED_SLOTS_KEY]
  return buf instanceof ArrayBuffer ? buf : null
}

/**
 * Install (or return the existing) per-runtime WorkletRuntime singleton. Reads the
 * shared-slot ArrayBuffer from `globalThis.__rngpui_svSlots` (installed by the rust
 * host). The channel adapter (worklet-channel.ts) wires itself in via installChannel
 * — this installs the runtime against a supplied channel. If no channel is supplied
 * the caller is expected to follow up with installChannel(role, runtime).
 *
 * Returns null when the shared-slot buffer is absent (bun unit tests without the
 * host bridge): callers then keep their local-only path.
 */
export function installWorkletRuntime(opts: {
  role: WorkletRuntimeRole
  channel: WorkletChannel
  buffer?: ArrayBuffer
}): WorkletRuntime | null {
  const existing = getWorkletRuntime()
  if (existing) return existing
  const buffer = opts.buffer ?? getSharedSlotsBuffer()
  if (!buffer) return null
  const rt = new WorkletRuntime({ channel: opts.channel, buffer, role: opts.role })
  setActiveWorkletRuntime(rt)
  return rt
}

// constants exported for tests
export const __WORKLET_RUNTIME_INTERNALS = {
  SAB_HEADER_FLOATS,
  SAB_MAGIC,
  DEFAULT_CAPACITY,
  OBJECT_ID_BASE,
  SHARED_SLOTS_KEY,
}
