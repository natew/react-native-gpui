# Renderer-driven pseudo states for Tamagui (design — not yet built)

Goal (user direction, 2026-06-09): kill the per-site `transition="0ms"` /
`animation` / `group` requirement in app code. The renderer should tell Tamagui
"node X is hovered/pressed" directly, and Tamagui should run its normal driver
path (spring if the style declares one, instant otherwise) — no special hover
props anywhere, no React-event hover lane. The previous "isDesktop defaults
pseudo transitions to instant" attempt was the wrong frame: transition duration
is an animation concern, orthogonal to desktop-vs-web.

## Why the renderer owns the trigger

rngpui already resolves hover/press natively per hitbox at paint time
(`pseudo_style.rs`, zero latency, no responder round-trip). Today that native
state only feeds renderer-side pseudo styles; Tamagui separately re-derives
hover from mouseEnter/mouseLeave React events (a full event→JS→setState lane —
or, with the avoidReRenders gate open, an emitter update). The event lane is
both laggier than the hitbox and the reason fast sweeps skip rows.

## Mechanism

1. **Host → JS pseudo lane.** The host emits a coalesced `pseudo` event
   `{id, hovered, pressed}` when a hitbox's pseudo state flips (it already
   computes the flip; this adds a bridge emit). Latest-wins coalescing per id,
   same class as mouseMove in the queue.
2. **rngpui pseudo registry.** A JS registry maps globalId → listener.
   Components register on mount (the reconciler Instance's `.id` IS the
   globalId).
3. **Tamagui core hook.** `@tamagui/core` gains ONE extension point for
   renderer platforms (user direction: a single `setupPlatformDriver(driver)`
   so more capabilities slot in over time — pseudo states now; later candidates:
   measure, focus, scroll). First capability:
   `driver.pseudo: { subscribe(hostInstance, listener) => dispose }`.
   When a platform driver with `pseudo` is present:
   - createComponent skips wiring its own hover (and optionally press) event
     handlers entirely;
   - the avoidReRenders gate opens for ANY component with pseudo styles (no
     animation/transition/group prop required);
   - the driver's signal feeds the existing `setStateShallow`/emitter path, so
     hover style updates ride the animation driver: spring if styled, instant
     otherwise, zero React commits either way.
4. **gui sweep.** Remove the 38 `transition="0ms"` props (gui/AGENTS.md rule
   retires); behavior is then renderer-triggered + driver-animated by default.

With the off-thread worklet runtime (plans/off-thread-reanimated.md) the
animation already leaves the React thread; this hook removes the React-event
*trigger* lane too. End state matches web CSS `:hover` semantics with native
springs on top.

Far future: route the pseudo signal straight to the worklet runtime (skip the
React thread entirely). Blocked on UI-side style resolution for pseudo merges —
not needed for parity with web.

## Coordination

The tamagui-side latch fix lives on branch `v2-fix-reaniamted-fast-path` in
~/tamagui (other session, landed). The aborted isDesktop work was rolled back —
nothing to build on there.
