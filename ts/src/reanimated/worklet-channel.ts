// host-fn channel adapter for the worklet runtime.
//
// the two Hermes runtimes (React + UI) cross only as JSON strings through rust
// host fns (see plans/off-thread-reanimated.md §Crossings):
//   - React→UI:  __rngpui_uiPost(json)  (host fn present on the React runtime)
//   - UI→React:  __rngpui_jsPost(json)   (host fn present on the UI runtime)
// rust posts the decoded string onto the OTHER runtime's queue by calling that
// runtime's `__rngpui_peerRecv(json)`, which this adapter installs.
//
// this adapter implements the WorkletChannel interface the runtime expects:
//   - send(msg)  → JSON.stringify → the role-appropriate host post fn.
//   - hasPeer()  → whether that host post fn exists in this runtime.
// inbound: globalThis.__rngpui_peerRecv = (json) => runtime.onMessage(JSON.parse(json)).

import type { WorkletChannel, WorkletMessage, WorkletRuntime, WorkletRuntimeRole } from './worklet-runtime'

// the React runtime posts to the UI runtime via __rngpui_uiPost; the UI runtime
// posts back via __rngpui_jsPost.
function postFnName(role: WorkletRuntimeRole): '__rngpui_uiPost' | '__rngpui_jsPost' {
  return role === 'react' ? '__rngpui_uiPost' : '__rngpui_jsPost'
}

function getPostFn(role: WorkletRuntimeRole): ((json: string) => void) | null {
  const fn = (globalThis as Record<string, unknown>)[postFnName(role)]
  return typeof fn === 'function' ? (fn as (json: string) => void) : null
}

const BRIDGE_TRACE_RAW =
  (typeof process !== 'undefined' && (process as { env?: Record<string, string> }).env?.RNGPUI_BRIDGE_TRACE) || ''
const BRIDGE_TRACE = !!BRIDGE_TRACE_RAW
// RNGPUI_BRIDGE_TRACE=full dumps entire payloads (closure specs are deep).
const BRIDGE_TRACE_LIMIT = BRIDGE_TRACE_RAW === 'full' ? Number.POSITIVE_INFINITY : 600

export function makeChannel(role: WorkletRuntimeRole): WorkletChannel {
  return {
    send(msg: WorkletMessage): void {
      const post = getPostFn(role)
      if (!post) return
      const json = JSON.stringify(msg)
      if (BRIDGE_TRACE) console.error(`[bridge ${role}→] ${json.slice(0, BRIDGE_TRACE_LIMIT)}`)
      post(json)
    },
    hasPeer(): boolean {
      return getPostFn(role) !== null
    },
  }
}

/**
 * Install the inbound receiver so rust can deliver peer messages into this
 * runtime. `__rngpui_peerRecv(json)` is the single entry point rust calls on the
 * receiving runtime's queue; it decodes and hands the message to the runtime,
 * console.erroring (rather than throwing into the rust caller) on a malformed
 * payload.
 */
export function installChannel(_role: WorkletRuntimeRole, runtime: WorkletRuntime): void {
  ;(globalThis as Record<string, unknown>).__rngpui_peerRecv = (json: string) => {
    try {
      runtime.onMessage(JSON.parse(json) as WorkletMessage)
    } catch (err) {
      console.error('[worklet-channel] malformed peer payload:', err, json)
    }
  }
}
