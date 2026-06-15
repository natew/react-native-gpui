/**
 * Renderer platform driver — the rngpui half of plans/tamagui-pseudo-hook.md.
 *
 * The gpui host resolves hover/press natively per hitbox at paint time. Instead of
 * re-deriving hover from mouseEnter/mouseLeave React events (a full event → JS → setState
 * lane), the host emits a coalesced `pseudo` event ({hovered, pressed}) on each native flip
 * of a node that opted in (`pseudoEvents: true`). This module is the registry that fans those
 * events to per-node listeners, and the `platformDriver` object tamagui's `@tamagui/core`
 * `setupPlatformDriver(driver)` consumes.
 *
 * Contract with tamagui (consumed by setupPlatformDriver):
 *   platformDriver.pseudo.subscribe(hostInstance, listener) => dispose
 *     - hostInstance is the rngpui reconciler Instance; `instance.id` IS the host globalId.
 *     - listener is called with absolute { hovered, pressed } on every flip (latest-wins
 *       coalesced in the host queue), NEVER on the React event path — so a hover does not
 *       cause a React re-render.
 *     - subscribe sets the per-node opt-in (`pseudoEvents`) so the host starts emitting;
 *       dispose unsubscribes and clears the opt-in when no listeners remain for that node.
 */
import { setPseudoEvents } from "./reconciler";

// host fns installed on the React runtime (rust/src/hermes.rs). Off-thread pseudo
// routing (plans/off-thread-pseudo-routing.md): a node registers two shared-value
// slots (hover, press) keyed by its host globalId; on a native flip the host then
// writes those slot cells + wakes the UI worklet directly, instead of emitting a
// main-thread `pseudo` event. -1 for an axis = no slot (host keeps the main-thread
// emit for it).
declare const __rngpui_registerPseudoSlots: ((json: string) => void) | undefined;
declare const __rngpui_unregisterPseudoSlots: ((json: string) => void) | undefined;

export type PseudoState = { hovered: boolean; pressed: boolean };
export type PseudoListener = (state: PseudoState) => void;

// globalId → its listeners. Multiple subscribers per node are allowed (e.g. nested
// styled components); the host opt-in flips on the first and off after the last.
const listeners = new Map<number, Set<PseudoListener>>();

/**
 * Register a listener for a node's native hover/press flips, keyed by globalId, and turn on
 * the host's per-node opt-in. Returns a dispose that removes the listener and clears the
 * opt-in once the node has no listeners left. Used by `platformDriver.pseudo.subscribe`.
 */
export function registerPseudoListener(globalId: number, listener: PseudoListener): () => void {
    let set = listeners.get(globalId);
    if (!set) {
        set = new Set();
        listeners.set(globalId, set);
        setPseudoEvents(globalId, true);
    }
    set.add(listener);
    return () => {
        const current = listeners.get(globalId);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) {
            listeners.delete(globalId);
            setPseudoEvents(globalId, false);
        }
    };
}

/**
 * Fan a host `pseudo` event to the node's listeners. Called by the render layer's host-event
 * dispatch (render.ts) for `event === "pseudo"` — BEFORE the React `dispatchEvent` path, so
 * pseudo state drives the listener (and tamagui's animation driver) without a React commit.
 */
export function dispatchPseudo(globalId: number, hovered: boolean, pressed: boolean): void {
    const set = listeners.get(globalId);
    if (!set) return;
    const state: PseudoState = { hovered, pressed };
    for (const listener of set) listener(state);
}

/**
 * Off-thread pseudo: register two shared-value slots (hover, press) for a node by host
 * globalId so the host writes them + wakes the UI worklet on a native flip — no React
 * thread, no `pseudo` event, no listener fan-out. Also turns ON the host's per-node
 * pseudo opt-in so its hitbox handlers actually run (they now write slots). Returns a
 * dispose that unregisters and clears the opt-in. Pass -1 for an axis to leave it on the
 * main-thread `pseudo` lane. Used by the Tamagui reanimated driver in place of `subscribe`.
 */
export function registerPseudoSlots(
    globalId: number,
    hoverSlot: number,
    pressSlot: number,
): () => void {
    if (typeof __rngpui_registerPseudoSlots !== "function") return () => {};
    setPseudoEvents(globalId, true);
    __rngpui_registerPseudoSlots(JSON.stringify({ globalId, hoverSlot, pressSlot }));
    return () => {
        __rngpui_unregisterPseudoSlots?.(JSON.stringify({ globalId }));
        setPseudoEvents(globalId, false);
    };
}

/**
 * Whether the host supports off-thread pseudo routing — i.e. the register host fn is
 * installed. The Tamagui reanimated driver reads this to decide whether to take the
 * slot-driven worklet path (true) or fall back to the main-thread emitter (false).
 */
export const supportsOffThreadPseudo = (): boolean =>
    typeof __rngpui_registerPseudoSlots === "function";

/**
 * The renderer platform driver. tamagui's `@tamagui/core` `setupPlatformDriver(driver)`
 * consumes this: when a driver with `pseudo` is present, createComponent skips wiring its own
 * hover/press React event handlers, opens the avoidReRenders gate for any component with
 * pseudo styles, and feeds this signal into its existing setStateShallow/emitter path so the
 * style update rides the animation driver (spring if styled, instant otherwise) with zero
 * React commits. More capabilities (measure, focus, scroll) can slot in over time.
 *
 * `registerPseudoSlots`/`offThreadPseudo` are the off-thread upgrade: an animation driver
 * that can read shared-value slots inside its worklet (the reanimated driver) routes the
 * hover/press trigger straight to the UI runtime via slots, bypassing `subscribe` entirely.
 */
export const platformDriver = {
    pseudo: {
        subscribe(hostInstance: { id: number }, listener: PseudoListener): () => void {
            return registerPseudoListener(hostInstance.id, listener);
        },
        offThreadPseudo: supportsOffThreadPseudo,
        registerPseudoSlots,
    },
};
