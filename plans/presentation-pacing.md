# Presentation pacing

## What “120 fps” means

CPU paint timing is necessary but does not prove smooth output. A 3 ms draw can still
miss every other display deadline, and GPUI can present the same scene again without
new pixels. The presentation gate therefore measures all three stages:

1. the source produces a new animation or scroll value;
2. GPUI paints a new scene;
3. Metal reports when the drawable actually reached the display through
   `MTLDrawable.addPresentedHandler` and `presentedTime`.

`presentTraceStart` and `presentTraceStop` expose the last stage over the control
socket. Each sample includes its drawable id, actual presentation timestamp, and the
paint generation associated with the drawable. The harness coalesces drawable
callbacks with the same presentation timestamp before calculating cadence.

Video is a useful subjective check, but it is a weak timing oracle. Common macOS
capture paths record at 60 fps, duplicate frames, or alter compositor scheduling. The
drawable callback measures the app's final Metal output without those distortions.

## Proven baselines on a 120 Hz Mac

Measured on 2026-07-18 with a non-activating, on-screen composited test window:

| Path | Actual result | Interpretation |
| --- | --- | --- |
| GPUI display-linked procedural animation | present p50 8.33 ms, p95 8.33 ms, 0 gaps over 12.5 ms | the GPUI and Metal base can sustain 120 Hz |
| Agentbus Overview, 400 sessions | present p50 8.33 ms, p95 8.33 ms, 2 missed intervals in about 120 frames | real native scroll sustains 120 Hz |
| Agentbus sidebar with stationary hover, 400 sessions | present p50 8.33 ms, p95 8.33 ms, 3 missed intervals in about 120 frames | native scroll plus hover sustains 120 Hz |
| Tiny React `setState` animation | 182 rAF ticks, 150 paints, 149 distinct presented paint generations | React per-frame commits do not sustain 120 visual updates |

Run the strict engine baseline with:

```sh
cd ts
bun run conformance:presentation-pacing
```

Run the real Agentbus gate with:

```sh
cd /Users/n8/agentbus/gui
bun native-shell/scripts/measure-frame-cost.mjs --assert --require-120hz
```

The Agentbus scroll sequence is scheduled by the GPUI window display link. An older
harness sent one socket request, waited for its reply, and then slept 8 ms. That loop
averaged 9 to 10 ms and created the 90 to 100 fps result it was trying to measure.

## Engine fundamentals

The renderer is fast, but update scheduling still determines whether a fast frame
reaches the next display deadline.

- Continuous native paint should request its next frame from GPUI's window display
  link. A free-running 8 ms smoke timer produced present p95 16.67 ms and about 97
  distinct visual frames per second. `Window::request_animation_frame` changed the
  same effect to p50/p95 8.33 ms with no missed intervals.
- React should own structure and discrete state. React concurrent rendering can merge
  per-frame state updates, so a 120 Hz rAF clock does not imply 120 React commits.
  Scrolling, gestures, and animation should stay in AppKit, GPUI, or the off-thread
  animation overlay.
- GPUI rebuilds the immediate-mode element tree on each dirty draw. Retained layout
  reuse and list chunk recycling keep the current Agentbus scroll draw around 3 ms,
  but structural commits still scale with mounted nodes. Further tree and layout
  retention is the next large CPU-side engine win.
- Every performance gate for visible motion should report source events, paints, and
  actual Metal presentations. Paint-only FPS can hide missed display deadlines.

The remaining timer-driven native layout and `_gpuiTransition` animation drivers
should be moved to the same window display-link scheduling path and validated with
the presentation gate before the timer paths are deleted.
