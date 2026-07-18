#!/usr/bin/env bun
/**
 * pure-bun unit test for the off-thread worklet runtime
 * (src/reanimated/worklet-runtime.ts). constructs TWO WorkletRuntime instances in
 * ONE bun process — a 'react' and a 'ui' — wired to each other with loopback
 * channels (each channel's send() calls the OTHER runtime's onMessage), over a
 * single shared __rngpui_svSlots ArrayBuffer (the rust host's role). this lets us
 * exercise the real cross-runtime machinery without Hermes / rust.
 *
 * proves:
 *   - slot alloc striping (react=even, ui=odd)
 *   - primitive sv write on react visible via ui proxy read + listener fires via
 *     the microtask-coalesced svUpdateBatch
 *   - dispatchWorklet of a hand-built (__initData/__closure/__workletHash) worklet
 *     executes ui-side and returns a value with awaitReply
 *   - runOnJS-style jsCallback round-trip (ui worklet calls back into react)
 *   - closure cache reuse across two dispatches of the same (hash, closureId)
 *     preserving a mutation made by the first run
 *   - shareableRef identity across two dispatches
 *   - boolean slot type restoration (Float64 0/1 → false/true)
 *   - slot free parity guard (a runtime only frees ids matching its own parity)
 *
 * runs in milliseconds; no gpui capture, sandbox-safe.
 */

import {
  WorkletRuntime,
  createSharedValueBuffer,
  serializeValue,
  SHAREABLE_ID_KEY,
  __WORKLET_RUNTIME_INTERNALS,
} from "../src/reanimated/worklet-runtime.ts";
import { scrollTo } from "../src/reanimated/seam.ts";

let failed = false;
function check(name, ok, detail = "") {
  const status = ok ? "PASS" : "FAIL";
  console.log(`UNIT_${status} ${name}${detail ? ` ${detail}` : ""}`);
  if (!ok) failed = true;
}

// drain microtasks (the runtime flushes svUpdateBatch on a queued microtask).
const flushMicrotasks = () => new Promise((r) => queueMicrotask(r));

// --- shared backing buffer (the rust host's job) + two loopback runtimes -------
const buffer = createSharedValueBuffer();
// install it as the global the runtime reads (mirrors the rust host install).
globalThis.__rngpui_svSlots = buffer;

// loopback channels: react.send → ui.onMessage, ui.send → react.onMessage. peer is
// always present. messages cross synchronously (the real channel is async-FIFO, but
// synchronous loopback is a strict superset for these assertions and keeps the test
// deterministic without a scheduler).
let react;
let ui;
const reactChannel = {
  send: (msg) => ui.onMessage(JSON.parse(JSON.stringify(msg))),
  hasPeer: () => true,
};
const uiChannel = {
  send: (msg) => react.onMessage(JSON.parse(JSON.stringify(msg))),
  hasPeer: () => true,
};
react = new WorkletRuntime({ channel: reactChannel, buffer, role: "react" });
ui = new WorkletRuntime({ channel: uiChannel, buffer, role: "ui" });

// =========================================================================
// 0. platform functions cross by stable builtin name. their implementation is
// bundled as Hermes bytecode, whose Function#toString is not executable source.
// =========================================================================
{
  const spec = serializeValue(scrollTo);
  check(
    "platform-builtin-serializes-by-name",
    spec.kind === "builtin" && spec.name === "scrollTo",
    `spec=${JSON.stringify(spec)}`,
  );
}

// =========================================================================
// 1. slot alloc striping — react even, ui odd
// =========================================================================
{
  const a = react.allocSharedValueSlot(10);
  const b = react.allocSharedValueSlot(20);
  const c = ui.allocSharedValueSlot(30);
  const d = ui.allocSharedValueSlot(40);
  const header = __WORKLET_RUNTIME_INTERNALS.SAB_HEADER_FLOATS;
  check("alloc-react-even", a % 2 === header % 2 && a >= header, `a=${a}`);
  check("alloc-react-even-2", b % 2 === a % 2 && b !== a, `b=${b}`);
  check("alloc-ui-odd", c % 2 !== a % 2, `c=${c} a=${a}`);
  check("alloc-ui-odd-2", d % 2 === c % 2 && d !== c, `d=${d}`);
  // disjoint id lanes: no react id collides with a ui id.
  check("alloc-no-collision", a !== c && a !== d && b !== c && b !== d, `${a},${b} vs ${c},${d}`);
}

// =========================================================================
// 2. primitive sv write on react visible via ui proxy read + listener fires
//    via svUpdateBatch
// =========================================================================
{
  const slot = react.allocSharedValueSlot(1);
  // build a ui-side proxy bound to the same slot (what deserializing {kind:'sv'}
  // produces on the ui runtime).
  const uiProxy = ui.deserializeValue({ kind: "sv", id: slot });
  check("primitive-initial-read", uiProxy.value === 1, `ui sees ${uiProxy.value}`);

  let listenerFired = null;
  uiProxy.addListener(1, (v) => {
    listenerFired = v;
  });

  // write on react — coerces to the shared cell, then the microtask flush posts an
  // svUpdateBatch that the ui runtime applies and fires listeners.
  react.writeSlot(slot, 42);
  // the shared cell is updated synchronously (zero-copy), so the read is immediate.
  check("primitive-shared-read-immediate", uiProxy.value === 42, `ui sees ${uiProxy.value}`);
  // but the LISTENER only fires after the batch crosses the channel.
  check("primitive-listener-deferred", listenerFired === null, `before flush=${listenerFired}`);
  await flushMicrotasks();
  check("primitive-listener-fired", listenerFired === 42, `after flush=${listenerFired}`);
}

// =========================================================================
// helper — hand-build the babel-plugin-worklets shape the runtime expects.
// __initData.code is the function SOURCE (so evalWorkletCode rebuilds it on the
// peer); __closure is the captured-variable bag; __workletHash identifies the body.
// The body reads captured vars via `this.__closure.X` exactly as babel emits.
// =========================================================================
function makeWorklet(hash, source, closure = {}) {
  const fn = (0, eval)(`(${source})`);
  Object.defineProperty(fn, "__initData", { value: { code: source }, configurable: true });
  Object.defineProperty(fn, "__workletHash", { value: hash, configurable: true });
  Object.defineProperty(fn, "__closure", { value: closure, configurable: true, writable: true });
  return fn;
}

// =========================================================================
// 3. dispatchWorklet of a closure-carrying worklet executes ui-side and returns a
//    value (awaitReply). The closure captures a primitive + an sv proxy.
// =========================================================================
{
  const slot = react.allocSharedValueSlot(100);
  const svProxy = react.deserializeValue({ kind: "sv", id: slot });
  // a worklet that reads a captured sv and adds a captured constant.
  const worklet = makeWorklet(
    0xa001,
    `function () { 'worklet'; return this.__closure.sv.value + this.__closure.bump; }`,
    { sv: svProxy, bump: 5 },
  );
  const result = await react.dispatchWorklet(worklet, [], { awaitReply: true });
  check("dispatch-returns-value", result === 105, `got ${result} (want 105)`);
}

// =========================================================================
// 4. runOnJS-style jsCallback round-trip. react registers a callback; a ui-side
//    worklet captures it and invokes it; the call args ship back to react.
// =========================================================================
{
  let receivedOnReact = null;
  const cb = (x) => {
    receivedOnReact = x;
  };
  const wrapped = react.registerJSCallback(cb);
  // worklet captures the wrapped callback and calls it ui-side.
  const worklet = makeWorklet(
    0xa002,
    `function () { 'worklet'; this.__closure.cb(7); return 'called'; }`,
    { cb: wrapped },
  );
  const result = await react.dispatchWorklet(worklet, [], { awaitReply: true });
  check("jscallback-worklet-ran", result === "called", `got ${result}`);
  await flushMicrotasks();
  check("jscallback-roundtrip", receivedOnReact === 7, `react received ${receivedOnReact}`);
}

// =========================================================================
// 5. closure cache reuse across two dispatches of the same (hash, closureId),
//    preserving a mutation the first run made to the materialized closure.
//
// The runtime caches the materialized closure by (hash, closureId) when closureId
// > 0 (the dispatch path always assigns closureId > 0 via nextSerializedClosureId).
// A worklet that mutates its captured `state` object proves the SAME materialized
// closure object is reused: the second run sees the first run's mutation.
// =========================================================================
{
  const state = { count: 0 };
  const worklet = makeWorklet(
    0xa003,
    `function () { 'worklet'; this.__closure.state.count += 1; return this.__closure.state.count; }`,
    { state },
  );
  const r1 = await react.dispatchWorklet(worklet, [], { awaitReply: true });
  const r2 = await react.dispatchWorklet(worklet, [], { awaitReply: true });
  check("closure-cache-first", r1 === 1, `first=${r1}`);
  check("closure-cache-preserves-mutation", r2 === 2, `second=${r2} (want 2 — same materialized closure)`);
}

// =========================================================================
// 6. shareableRef identity across two dispatches. A makeShareable-stamped record
//    (SHAREABLE_ID_KEY) resolves to the SAME ui-side object on every ship, so a
//    mutation the worklet makes persists across re-ships (mapper remoteState
//    continuity).
// =========================================================================
{
  const remoteState = { last: 0 };
  // stamp it like the worklets stub's makeShareable does.
  Object.defineProperty(remoteState, SHAREABLE_ID_KEY, { value: 999, enumerable: false });
  // sanity: serializeValue emits a shareableRef for the stamped record.
  const spec = serializeValue(remoteState);
  check("shareableref-serializes", spec.kind === "shareableRef" && spec.id === 999, `kind=${spec.kind}`);

  const worklet = makeWorklet(
    0xa004,
    `function () { 'worklet'; this.__closure.s.last += 10; return this.__closure.s.last; }`,
    { s: remoteState },
  );
  const r1 = await react.dispatchWorklet(worklet, [], { awaitReply: true });
  const r2 = await react.dispatchWorklet(worklet, [], { awaitReply: true });
  check("shareableref-first", r1 === 10, `first=${r1}`);
  check("shareableref-identity-persists", r2 === 20, `second=${r2} (want 20 — same ui-side shareable object)`);
}

// =========================================================================
// 7. boolean slot type restoration — a boolean slot stores Float64 0/1 but proxy
//    reads restore the boolean type so `=== false` works like real reanimated.
// =========================================================================
{
  const slot = react.allocSharedValueSlot(0, /* isBool */ true);
  // the alloc message tells the ui runtime this is a boolean slot.
  await flushMicrotasks();
  const uiProxy = ui.deserializeValue({ kind: "sv", id: slot });
  check("bool-false-restored", uiProxy.value === false, `ui sees ${JSON.stringify(uiProxy.value)} (want false)`);
  react.writeSlot(slot, true);
  check("bool-true-restored", uiProxy.value === true, `ui sees ${JSON.stringify(uiProxy.value)} (want true)`);
  check("bool-strict-not-number", uiProxy.value !== 1, `value is boolean not 1`);
}

// =========================================================================
// 8. slot free parity guard — a runtime only frees ids matching its own
//    even/odd parity. freeing a peer-owned id is a no-op (no double-free, no
//    cross-lane corruption).
// =========================================================================
{
  const reactSlot = react.allocSharedValueSlot(1); // even (react-owned)
  const uiSlot = ui.allocSharedValueSlot(2); // odd (ui-owned)
  const before = react.getSlotStats().freeSlots;
  // react tries to free a ui-owned (odd) id — must be rejected by the parity guard.
  react.freeSlot(uiSlot);
  const afterWrongParity = react.getSlotStats().freeSlots;
  check("free-parity-guard-rejects-peer", afterWrongParity === before, `free-list ${before}→${afterWrongParity} (want unchanged)`);
  // react frees its OWN (even) id — accepted, lands on the free-list.
  react.freeSlot(reactSlot);
  const afterOwn = react.getSlotStats().freeSlots;
  check("free-own-accepted", afterOwn === before + 1, `free-list ${before}→${afterOwn} (want +1)`);
  // and a reused alloc hands the freed id back (free-list reuse).
  const reused = react.allocSharedValueSlot(3);
  check("free-reuse", reused === reactSlot, `reused=${reused} freed=${reactSlot}`);
}

if (failed) {
  console.error("WORKLET_RUNTIME_UNIT_FAIL");
  process.exit(1);
}
console.log("WORKLET_RUNTIME_UNIT_PASS");
