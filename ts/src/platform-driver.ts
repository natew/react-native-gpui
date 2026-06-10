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
 * The renderer platform driver. tamagui's `@tamagui/core` `setupPlatformDriver(driver)`
 * consumes this: when a driver with `pseudo` is present, createComponent skips wiring its own
 * hover/press React event handlers, opens the avoidReRenders gate for any component with
 * pseudo styles, and feeds this signal into its existing setStateShallow/emitter path so the
 * style update rides the animation driver (spring if styled, instant otherwise) with zero
 * React commits. More capabilities (measure, focus, scroll) can slot in over time.
 */
export const platformDriver = {
    pseudo: {
        subscribe(hostInstance: { id: number }, listener: PseudoListener): () => void {
            return registerPseudoListener(hostInstance.id, listener);
        },
    },
};
