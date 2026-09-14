# Desktop engine stress — react-native-gpui under the Team Machine desktop app

Branch `perf/desktop-engine-stress`, worktree `~/.worktrees/rngpui-desktop-engine-stress`,
based on `origin/main` `2555170`. Owns the upstream engine only. The Team Machine desktop app and
its gates are owned by the desktop QA lane (`desktop-deep-qa-manager-2`); findings in app or
dependency scope are handed back, not patched here. Nothing in this branch has been pushed: the
brief gates the push on Muse integration proof plus approval from `desktop-engine-integration-qa`.

Method: every claim is labeled RAN (I ran it, output quoted), READ (I read the code, file:line),
TESTED (ran it more than one way), INFERRED (follows from named observations), GUESSED. Gates live
in `ts/scripts/` and print `NAME_CONFORMANCE PASS|FAIL` with `process.exitCode = 1` on failure.

The repo has no CI of any kind (no `.github/` directory; `gh workflow list` is empty, exit 0), so
local gates are the only receipt this branch can have.

## Fixes landed

### 1. `:focus-visible` was true on a fresh mount — `8189058`

`useKeyboardNavigationController` requires an `initialId`, so every app using keyboard navigation
mounts with a focused target. `initialFocusVisible` defaulted to `true`, so that target read
`:focus-visible` on the first frame with zero input and its ring painted on a cold launch. On the
desktop app this is the full-stage `FOCUS_RING.dark` box shadow, which reads as a permanent divider
between the list and stage panes.

The default is now `false`; `initialFocusVisible: true` keeps the old behavior. The second-order
effect mattered as much as the default: `showCurrentFocus()` returns early when the ring is already
visible, so the keyboard reveal was a no-op and no keyboard path could clear the pre-lit ring.

Gate `conformance:focus-visible` asserts both directions, hidden at mount and visible after
`activateFocused()`, because a regression that removed the ring outright would satisfy the first
line alone. RAN pre-fix: `initial alpha=true beta=false` with no keyboard line at all. Post-fix:
`initial alpha=false beta=false` then `keyboard alpha=true beta=false`. The negative control is
`RNGPUI_FOCUS_VISIBLE_INITIAL=1`, read by the fixture at `ts/examples/focus-visible-conformance.tsx:46`,
which opts back into the old default and makes the gate fail on the first line.

### 2. Trace diagnostics — `561d1fc`

Behavior-neutral. The level-2 `setNodeStyle` trace now prints animated values, not just keys, and
`RNGPUI_LOG_THREAD=1` prefixes each line with the runtime that spoke (`jsc-js` or `jsc-ui`). Both
were needed to isolate the dialog finding below. Default output is unchanged.

### 3. Scroll settle repainted the whole tree — `8edbfb9`, reverted `cb485a3`, reapplied `f008c1e`

`suppress_pseudo_hover_during_native_scroll` (`rust/src/elements/div.rs`) refreshes the tree 80ms
after a native scroll ends, to re-derive the retained pseudo hitboxes at the final offset. That
refresh called `window.refresh()` without arming the paint-only fast path, so it reached the
retained-layout gate with nothing dirty, failed `want_reuse`, and forced a full taffy solve at the
end of every native scroll.

RAN, pre-fix: the interleaved `[retained]`/`[draw]` trace shows the settle frame with
`paint_only=false` and every dirty flag false, then `[draw] 32-44ms reuse=false` against
`[draw] 5.8ms reuse=true` for the neighbouring frames. Pre-fix 2 full-layout frames per run in 4/4
runs, post-fix 0 in 4/4.

Gate `conformance:scroll-settle-retained` waits for quiescence rather than for a clock, sends one
`nativeDriverWheel` began/ended pair, and asserts every `[draw]` in the slice reports `reuse=true`.
It honors `RNGPUI_SERVICE` so an A/B against a pre-fix binary is a real A/B; several older gates
overwrite that variable unconditionally, which silently collapses an A/B into two runs of the same
binary.

The revert and reapply are both in the history rather than squashed: the revert was a mistake made
on a non-reproducible measurement (see below), and this branch does not rewrite history. The net
effect is the original change.

### 4. A blank capture was reported as a corner/shadow defect — `06ac787`

The capture timer writes a frame every 25ms from service start, so a slow first paint yields frames
of uniform window background. `waitForCapture` (`ts/cli/host.ts:624`) checked only that the frame
file existed and was non-empty, so a blank frame reached the assertions. This gate read one as
`terminal interior should be the terminal fill — got #232323` (the fixture paints `#050507` there)
plus `terminal shadow should fall off — 4px out (lum 35) must be darker than 40px out (lum 30)`, an
inverted gradient. Sampling that capture with the gate's own helpers returned `#232323` at every
point including the field, which the fixture paints `#f2c84b`: nothing had painted.

RAN: the same fixture, binary and command then passed three consecutive runs, at load 13.5, 16.5 and
19.1. The highest load passed and the failing run was not the most loaded, so this does not track
load the way the feed gate does. TESTED: whole-frame luminance variance is 7567.6 on a real 900x620
frame and 0 on a uniform one; the new precondition rejects the observed blank (`#232323`, max
channel delta 207) against a tolerance of 40 and accepts the painted field (`#ebc864`). INFERRED: the
blank frame is a first paint slower than the capture. The observation that would have differed is a
failing run whose capture is verifiably non-blank; I did not get one, and I no longer hold the blank
frame because the later passing runs overwrote it.

Fix: wait for painted pixels before the first capture (whole-frame variance, best-effort, 1500ms
budget, `RNGPUI_SHOT_FRAME_BUDGET_MS`), and assert in the gate that the app painted before measuring
geometry.

Two things this gate got right, once it could see: with a real capture the corner and shadow
assertions all pass (corner `#dcb95a` clipped away from the terminal fill, interior `#050505`, shadow
44 lum darker 4px out and falling off), so there is no engine defect in corner clipping or drop
shadow. And its header comment describing the capture as an "in-service CGWindowList readback" is
stale: `host.capture` copies the frame the service writes to `RNGPUI_CAPTURE_PNG`.

### 5. The input color check scaled the node box by a stale window height — `3cfab6c`

`assertNodeContainsColor` divided node bounds by a hardcoded logical `780x520` while the gate
launches at `780x620`, so `scaleY` was 2.385 instead of 2.0 and every sampled band sat ~19% low. The
placeholder box (`y` 192..248) was read at rows 457..592, below its glyphs, and a painted `#ff4fa3`
was reported absent as `nearest RGB distance 189.9`.

TESTED: replaying both scales over the gate's own capture reproduces its exact number (old scale
rows 457..592, nearest 189.9, zero pixels within tolerance; corrected scale rows 384..496, nearest
23, 1878 pixels). RAN: a probe of the live fixture shows the node carries `text: "COLOR_SENTINEL"`
and its box paints 1447 pixels of `#eb5fa0`, and `rust/src/elements/input.rs:83` applies
`placeholder_text_color` unconditionally. The defect was the gate's arithmetic, not the engine's
color plumbing.

### 6. The React-stall scroll gate raced its own window — `28da8b4`

`native-scroll-react-stall-conformance` fired a 101-step frame-paced sequence and then failed if the
fixture's fixed 2000ms React busy-wait had ended first, i.e. it required all 101 frames plus three
control round trips to fit inside a window the machine's load decides. At load 22 the sequence
overran it and the gate reported `the React stall ended before the scroll proof completed`, which
reads as a sequencing defect in the engine and is really a claim about how fast the machine is. The
engine's own `conformance-utils.mjs` already states the principle for the same class of problem: an
absolute deadline is a claim about machine speed, and it is wrong on a busy one.

The sequence reply lands only at the end (`rust/src/service.rs:2538`, one step per
`window.on_next_frame`, reply sent when `phase == "ended"`), so awaiting it inside the stall is what
created the race. The gate now samples the AppKit driver 800ms into the stall, reading the log on
both sides of the round trip so `during the stall` is checked rather than assumed, and requires
`offsetY >= 200px`, twenty of the sequence's ten-px steps. The stall ending first is no longer a
failure; the sequence must still dispatch all 101 steps, which the gate now waits for as a condition
with a named timeout instead of hanging. This follows `offthread-stall-conformance`, which counts
`setNodeStyle` crossings inside its own stall window and accepts `>= 25` "for a loaded machine".

TESTED: two negative controls, each run and each failing as intended. With the sequence fired after
`STALL_END` the gate reports `native scroll stalled with React — offsetY=0px at 800ms into the React
stall (floor 200px)`, so the floor is a real check and nothing else in the fixture moves the offset.
With the sample moved to 4000ms it reports `the fixture's 2000ms React stall ended before the
mid-stall sample landed (4000ms in)`, so a post-stall sample cannot masquerade as an in-stall one.
RAN, the fixed gate 3/3 at load 14.7: `midStallOffset=960/960/950px at=800ms`, `frames=102
p95=8.33ms over12.5=2 offset=1000`. So 95-96 of the 101 steps dispatch while React is pinned, at a
full 120Hz frame period, and the earlier red was the window and not the engine.

## Local validation on this tip

RAN, `bun run test` (`ts/scripts/test-suite.mjs`): `TEST_SUITE_TOTAL seconds=24.755`,
`TEST_SUITE_PASS`, 40 tasks, none skipped. Includes `focus-visible` (5.829s),
`scroll-settle-retained` (5.057s), `opacity-ramp` (6.800s), `opacity` (2.580s), `animation-diff`
(5.934s), `offthread-stall` (3.085s), `raf-pacing` (1.884s), `cargo-test` (12.827s) and `typecheck`
(6.237s).

RAN, `conformance:reanimated`: `REANIMATED_CONFORMANCE distinctWidths=16 setNodeStyle=267
applyTree=4 ramp=PASS fastPath=PASS`.

RAN, `conformance:dialog-reanimated`: still FAIL, `opacitySamples=1 opacities=[1] ySamples=0
setNodeStyle=3 applyTree=6 lateBg=#ffffff exitOpacities=[1] ramp=FAIL fastPath=FAIL bgPaints=PASS
exitRamp=FAIL exitUnmount=PASS`. That finding is open, not fixed.

RAN again after `06ac787` and `3cfab6c`: `TEST_SUITE_TOTAL seconds=15.909`, 40 tasks, all PASS. An
earlier run of the same suite failed only `scroll-settle-retained`, on
`fixture stole focus from pid 41055 to 51022`; the suite's own closing line identifies pid 41055 as
Ghostty and the new frontmost as Safari, which no fixture can be, and the gate then passed 3/3 with
Safari frontmost throughout, so that was an external activation rather than the fixture.

RAN, gates outside the suite that I had not triaged before this session. PASS: `anim-overlay`
(`distinctWidths=8 setNodeStyle=117 applyTree=4 ramp=PASS fastPath=PASS`), `card-corner-shadow` 3/3,
`check-transform`, `context-menu`, `describe`, `webview-overlay` (`webviewPainted=true`), `drive`,
`reanimated-scroll` (`host=446 target=180 offset=7000 elapsed=60.1ms`).

Load-bound failures, each needing a clean-machine run rather than a code change, with the
observation that says so.

`startup-conformance` is CPU time, not a wait: it asserts a 200ms cold start against the engine's own
internal path (`[startup] first paint complete`, the same marker `legend-100k` budgets at 200ms), and
across four batches of six launches at load 14-22 on an 18-core box that internal number ran 138-178ms
in the single batch that passed and 196-421ms in the three that failed, with wall minus internal a
steady 10-20ms in all four. The metric is therefore not what moves. The phase medians say which work
stretches: `bundle evaluated` holds near 23ms while `Application::new` goes 36.6 to 78.6ms,
`app.run entered` 45.5 to 80.1ms and `open_window cb: pre glass` 64.5 to 78.8ms, so the engine's own
init and window creation take about twice as long when 22 runnable tasks share 18 cores. The gate's
header says it fails on internal first-render time while `measure-startup.mjs` asserts the wall max;
both were over in every failing run, so that inconsistency decides nothing here and I left both alone.

The quietest batch I have run moves the variable off load. At loadavg 8.82 the six launches measured
wall/internal 236/201, 200/189, 188/176, 172/160, 150/140, 141/132ms, monotonically faster, and red at
`wall max 236.3ms > 200ms`. Two batches fired immediately after, at loadavg 10.52 and 11.09, so at equal
or higher load, measured 99-136ms wall and 88-125ms internal across all twelve launches and PASSED
both. RAN. The discriminating observation is that load pair: were load the variable, the later batches
would have been the slower ones. What differs is recency, since the failing batch was the first launch
after roughly 45 minutes idle and the passing ones followed launches. The engine's warm cold start is
88-136ms internal, inside the budget with real headroom, while the coldest first launch of a session
measured 201ms internal and 236ms wall. The gate asserts the max of six, so it asserts the coldest run
in the batch, which is the number a user's first launch after idle gets. Budget and metric untouched.

Load average is the wrong instrument here, and it is why the wait for a clean window was mis-aimed.
`top` has read 19-41% idle at loadavg 30, and 43.9% idle at loadavg 49.6, so loadavg counts runnable
threads rather than available CPU, and it read 8.82 during the cold batch above while a warmer machine
at 11.09 passed. A 45-minute detached wait keyed on `loadavg < 9` expired without firing.
`ts/scripts/quiet-window.sh` replaces it: it samples CPU idle from the second of two `top -l 2`
samples, requires the condition to hold for N consecutive readings, and prints its readings on both
sides of the command it runs. Controls, run: a trivially satisfiable condition opened and ran its
command, a failing command propagated rc=1, and an unsatisfiable one timed out naming the deadline it
used. The first also measures how narrow a window is here, bracketing one `echo` with idle 38.23%
before and 4.56% after. The controls caught a real bug in it, since `status` is read-only in zsh: the
close line never printed and the script exited 1 on every run.

`input-runtime`'s `click-to-painted-focus`, a 16.67ms budget, median 18.19/p95 21.71ms at load 22
with individual samples at 11.06ms. The machine was running a SootSim simulator conformance app, an
`xcodebuildmcp` build, a codex session, `agy` and three `bun` runs.

Re-run at loadavg 20.43 rising to 39.05 during the gate: FAIL at median 22.46/p95 36.25ms, samples
51.61, 26.37, 30.77, 16.60, 36.09, 25.76, 36.25, 13.88, 21.26, 23.21, 18.17, 20.48, 21.02, 22.46, 22.59,
16.37, 15.46, 10.35, 33.12, 17.76. Five of the twenty, 10.35 to 16.60ms, are inside the budget, so the
uncontended floor is in budget and the tail is contention. RAN.

That number is not the engine's, and neither is the probe that looks like one.
`probe:input-latency` is a non-asserting twin of the same loop: identical `settledFrameCount` gate,
identical `sleep(1)` poll, identical `realtap`. Both start the clock before the tap's control-socket
round trip and stop it one poll iteration after the paint, so every sample carries that round trip and
up to a millisecond of quantisation. The engine records no input latency of its own:
`RNGPUI_INPUT_PAINT_TRACE` captures `frame`, `focusedId`, `value` and `eventCount` and no timestamp,
unlike `RNGPUI_SCROLL_LATENCY_PROBE`, which records an `Instant` at dispatch and prints the delta in
`present()`.

The least-busy-window run came back and does not settle it (job `w-b3a4`; the window opened at idle
48.85% and closed at 25.4%, loadavg 20.43 to 25.69): FAIL at median 21.02/p95 66.19ms, samples 10.19,
10.41, 11.07, 11.60, 12.27, 13.40, 13.82, 18.21, 18.99, 20.39, 21.02, 22.40, 25.99, 26.68, 28.15,
33.90, 37.84, 63.55, 66.19, 68.75. Seven of the twenty are inside budget and the floor is 10.19ms, so
the engine still reaches a frame. The probe, run about forty seconds earlier in the same window,
measured focus median 15.45/p95 27.54/max 48.98ms: inside budget on the median, where the gate's own
median forty seconds later was 21.02ms for the same fixture and the same code path. Identical
interactions span 10.19 to 68.75ms, a 6.7x spread, and the same measurement lands on opposite sides of
the budget inside a single window. RAN.

So the verdict this gate asks for is not obtainable on this machine, and the cause is its statistic
rather than the engine. At twenty samples, `Math.ceil(20 * 0.95) - 1` is index 18, the second largest,
so the gate asserts that at most one of twenty taps is slow. That is the standard nearest-rank p95, and
at n=20 it is a near-max: one scheduler stall decides the run, which is why this gate reds nearly every
time. I changed neither the assertion nor the sample count. Both move strictness, and a median of
21.02ms is genuinely outside the budget rather than a tail artifact, so this is not a case of a good
number spoiled by an outlier. Settling it needs a window whose idle never leaves a chosen floor, since
this one drifted 48.85% to 25.4%, or an engine-side input clock that the engine does not have. Three
samples cluster at 63.55, 66.19 and 68.75ms, near four 60Hz frame periods; whether that is an engine
hitch or four frames of scheduler delay is exactly what nothing available here can separate.

## The Team Machine feed gate is load-bound, not a regression from `8edbfb9`

RAN, real app integration. `gui/native-shell` `feed-legendlist-scroll` failed with
`timed out waiting for feed LegendList tree targetId=4 rows=Feed row 74..79`: the deep row never
renders, and the list never moves off the top. It fails on every binary I point the gate at, my
engine build included.

I first read that as my regression and reverted `8edbfb9` as `cb485a3`. That was wrong, and the
evidence against it is now four-sided:

- The reverted build (Rust source in `div.rs` byte-identical to the control) failed 3/3.
- The control binary, which had passed 3/3 earlier, was re-run at the load that then obtained
  (29 to 39): 1 PASS, 2 FAIL, same `rows=Feed row 74..79` signature.
- The two arms therefore overlap. The variable that tracks the outcome is machine load, not the arm.
- The original 3/3-versus-3/3 separation was an ordering artifact: in that batch I always ran `mine`
  before `control` within each pair, so any cold-start or time-varying effect landed systematically
  on one arm.

What actually moved: load average went 14.05 to 38.91 with external consumers I do not own, sampled
at the failure: Android emulator qemu 147.7%, `xcodebuildmcp` node-runtime 115.8%, another session's
`TeamMachine Dev.app` 100.1%, `~/team-machine/.deploy/tm` 97.5% up 1h53m, `rustc` 89.5%. No service
leak of mine: `ps -eo pid,comm | grep -c rngpui-service` = 1. The app's own perf gates require a
clean load under 9.0, and this gate's phase-2 wait is 8s of wall clock.

Two methodology traps cost real time here and are worth carrying forward:

- `rust/target/release/rngpui-service` has `LC_RPATH = @executable_path` and `@loader_path`, and
  `libghostty-vt.dylib` lives in that directory. Copying the binary to `/tmp` to A/B it produces
  `dyld: Library not loaded: @libghostty-vt.dylib`, and a dead service presents as "timed out waiting
  for the tree", which I first misread as a load failure. Both arms of A/B #1 were dead binaries.
  Stage A/B binaries as siblings of the dylib and re-sign after any `cargo build`:
  `codesign --force --sign - --entitlements rust/jsc.entitlements <binary>`. `npm run build:rust` is
  cargo alone, so it invalidates the signature in place and every launch then fails as
  `[jsc] fatal: JIT liveness probe took 331.8ms (limit 100.0ms); the process is interpreter-shaped`
  followed by the host's `window did not appear`, which reads like a fixture bug rather than an
  unsigned binary. `npm run build:native` is the step that re-signs both entry points.
- An A/B needs the arms interleaved in both orders, and a null result needs a control that can fail.
  A pass/fail gate under variable external load cannot separate a 2ms layout difference at all.

## Open finding: a Tamagui `transition` enter has nothing to animate from

Engine-side finding, reproduced in this repo's own gate. Handed to the desktop QA lane; not fixed,
because the evidence puts the locus outside the engine.

RAN: `conformance:dialog-reanimated` reports
`opacitySamples=1 opacities=[1] ySamples=0 setNodeStyle=2 applyTree=7 lateBg=#ffffff exitOpacities=[1] ramp=FAIL fastPath=FAIL bgPaints=PASS exitRamp=FAIL exitUnmount=PASS`.
At the seam, `_updateProps` is called exactly twice in the whole run, once for open and once for
close, each `ops=4`, each already settled:
`opacity=1 transform=[{"scale":1},{"translateY":0}]`, from `[jsc-ui]`. The enter start
(`opacity` 0, `scale` 0.85, `translateY` 24) is never written and never sampled.

READ, `@tamagui/animations-reanimated` (prebuilt chunk, the worklet the mapper calls per key),
`animateSnapshotValue`:

```js
var cycleGated = gated && (currentlyExiting || currentlyCompletingEnter || currentlyCompletingUpdate);
if (!previouslyEmitted && seedValue === void 0 && !cycleGated) return targetValue;      // :2375
return applyAnimation(targetValue, config, callback,
  previouslyEmitted ? void 0
    : seedValue !== null && seedValue !== void 0 ? seedValue
    : getImplicitDefault(implicitKey, targetValue), ...);                              // :2461
```

`seedValue` is `snapshot.seeds[key]`, and `seeds[key] = lastPainted[key]` (`:2100-2106`), the last
value painted on screen. On a cold mount nothing has been painted for that key, so it is `undefined`.
`getImplicitDefault('opacity', 1)` returns 1, the target. So on the first mapper frame the driver has
neither a seed nor an enter cycle flagged, and **both** exits yield the target: the early return at
`:2375`, or `applyAnimation(target, ..., start = 1)` at `:2461`, an animation from 1 to 1.

That is the observed `opacities=[1]` exactly. No frame is dropped and no value is reordered; the
driver was never given a start value, so a one-write settle is the correct output for its inputs.

Consequences for where the bug lands: the enter start must reach the driver as either a painted seed
(tamagui core paints the enter value on the first commit and the driver seeds from it) or an enter
cycle flag (`currentlyCompletingEnter`, set by the driver's own enter dispatch). Neither is present
at the first mapper frame. The engine's contribution to the first is what the first commit's style
carries; to the second, the worklet dispatch ordering.

Negative controls on the same seam, RAN: `conformance:reanimated`
`setNodeStyle=266 ramp=PASS fastPath=PASS`, and `conformance:sustained-reanimated` `fastPath=PASS`.
Worklet delivery and the overlay do ramp, so worklet frames themselves are not the fault.

Retracted (mine): an earlier INFERRED claim in this file said tamagui resolves `transition="medium"`
to `entries: []` through `resolveTransition` because its animations config is not threaded in. The
app lane disproved it at the real path: `resolveTransition('medium', { animations })` returns a
spring, `duration 300`, `stiffness 438.6`, `damping 35.6`, `diagnostics: []`, on both the gpui and
the reanimated maps, with the same raw closure map the driver uses. Preset miss is dead.

Also relevant, READ: `__rngpui_animateNodeStyle` has a live Rust handler
(`host_animate_node_style` to `Incoming::AnimateNodeStyle` to `rust/src/anim_overlay_tween.rs`) and no
JS caller anywhere: not in `ts/src`, not in the prebuilt tamagui or reanimated chunks, not in the
app's `node_modules/@tamagui`. `git log -S` shows the only commit that ever contained it is `f76868e`,
which installs the host fn. A `transition`-prop animation therefore cannot reach the native tween
engine in this stack, whatever the driver emits.

Next probe, named, and attempted: instrument the driver's first mapper frame
(`tamagui_createAnimationsNativeJs23`) and log `snapshot.seeds`, `animatedValues`, `snapshot.gatedKeys`
and the three cycle flags at that frame. That distinguishes "core painted no enter value" from "the
enter cycle never started". The attempt did not produce a valid observation, so the fork is still
open, and the reason is worth recording because it invalidates an easy conclusion:

- The mapper exists in two forms in the prebuilt chunk: a source closure and the serialized
  `__initData.code` string that a worklet is materialized from. I patched both, ran the gate with the
  chunk's own `RNGPUI_SKIP_PREBUILD=1` debug hook, and got no probe output.
- That silence is **not** evidence about the mapper. RAN, the control: the bundled app
  (`/tmp/rngpui-dialog-reanimated-conformance/app.js`) contains `tamagui_createAnimationsNativeJs23`
  10 times and `animateSnapshotValue` 8 times, and contains **zero** occurrences of my probe strings.
  The gate resolves `@tamagui/animations-reanimated` from the app's `gui/node_modules` and does not
  use the prebuilt chunk it stages in `/tmp` after all, despite passing `prebuiltDir` to the bundler
  plugin. So all three probe runs measured an uninstrumented driver.
- Instrumenting the file the gate actually bundles means editing a package in `~/team-machine/gui/node_modules`.
  That tree is app-owned and shared with a lane that runs its gates concurrently, so it is off limits.
  The fork therefore cannot be closed from this side without either that permission or a fixture that
  does not import the app's Tamagui stack.

Two negatives I nearly reported and am not reporting: "the source variant never runs" and "the mapper
never runs". Neither is supported by a channel that was shown to work.

## Read and deliberately not landed: `_WORKLET`

READ: the native runtime decorates both runtimes with this global,
`Common/cpp/worklets/WorkletRuntime/WorkletRuntimeDecorator.cpp:67` sets `_WORKLET` true on the UI
runtime and `RNRuntimeWorkletDecorator.cpp:25` sets false on the RN runtime. This engine sets it only
transiently, inside `runWithWorkletFlag` (`ts/src/reanimated/worklet-runtime.ts:1738-1747`), and grep
over `ts/src` finds no other writer. The seam already claims a UI kind for both runtimes
(`seam.ts:198-201`, and `worklets.ts:1116-1122` explains that choice), so `_WORKLET` is an
inconsistency in the same decoration the engine already performs.

Not landed, and it should stay that way without a symptom. The only consumer in this stack is
tamagui's `updateMapperState`, the sole writer of `mapperState.emitted`, so the global's absence
leaves `emitted` permanently `{}`. That cannot produce the dialog symptom: `emitted` reaches
`animateSnapshotValue` as `previouslyEmitted`, and both of its uses are dead here (`:2375` needs
`seedValue === undefined` either way; `:2461` yields 1 either way, because the fallback is
`getImplicitDefault` = 1). RAN, the line is not behavior-neutral either: with it the dialog gate
reports `setNodeStyle=0 applyTree=4 exitUnmount=FAIL`, and the two runs without it report
`setNodeStyle=2 applyTree=7 exitUnmount=PASS` and `setNodeStyle=3 applyTree=6 exitUnmount=PASS`. One
run against two is a thin arm, but `exitUnmount` flips categorically rather than drifting, so the
line does something I have not explained, and landing an unexplained change to a global that
third-party worklet code branches on is worse than leaving a documented inconsistency.

## The dialog gate does not re-stage the UI runtime, so it can test stale engine source

RAN, proven with a positive control. The service does not evaluate `ts/src`. It evaluates a built
bundle staged beside the binary: `rust/src/service.rs:2864-2871` resolves `ui-runtime.js` next to the
executable (or from `RNGPUI_UI_BUNDLE`), produced by `ts/scripts/build-ui-runtime.mjs` from
`src/reanimated/ui-entry.ts`. That builder is mtime-gated over `src/reanimated/` and `src/raf.ts`,
and it is invoked from exactly two places: `scripts/build-native.mjs`, which is part of
`npm run build`, and `scripts/bundle-app.mjs`, after every app bundle. No gate invokes it: grep
finds no reference to `build-ui-runtime` in `scripts/dialog-reanimated-conformance.mjs` or in
`scripts/reanimated-bun-plugin.mjs`.

The consequence, RAN: I appended one log line to `src/reanimated/ui-entry.ts` and ran the dialog
gate, and it never appeared. I then ran `bun scripts/build-ui-runtime.mjs`, which rebuilt and
re-staged the bundle, and re-ran the same gate unchanged: the line appeared. The first run had been
reading a bundle built before the edit. That bundle is also what carries the engine's own
`[anim-trace]` lines, so a gate can report an older revision of the UI runtime while appearing to
test current engine behaviour.

This is why the `_WORKLET` arm above is recorded as acting on the React runtime only: the seam is
installed on both runtimes, and the UI runtime bundle was not re-staged during those runs, so an edit
to `ts/src/reanimated/seam.ts` could only have reached the React runtime, which the gate bundles
fresh on every run.

Operationally: after changing anything under `ts/src/reanimated/` or `ts/src/raf.ts`, run
`bun scripts/build-ui-runtime.mjs` before trusting a gate result, and rebuild and re-sign
`rngpui-service` after changing `rust/`.

## App integration

Built the engine into the Team Machine test app without publishing:
`RNGPUI_LOCAL=<worktree>/ts bun run bundle:gpui` wrote `native-shell/.gpui/app.js` (11289 KB,
`lib=/Users/n8/.worktrees/rngpui-desktop-engine-stress/ts`). `.gpui/` is gitignored, so no app source
was touched and no app file was modified at any point in this lane.

RAN, wave 1 (`--filter new-tab,hover-active,timeline,command-palette,data-model,diff`):
`CONFORMANCE_PASS checks=11 failed=0` in 40.3s wall, no `FOCUS_THEFT`. The same filter against the
app lane's own build also reports 11/11, so this is like-for-like and my engine build is not a
regression on those surfaces. `hover-active` (28.13s) and the four perf-labelled checks
(`timeline-stream-perf`, `diff-sidebar-perf`, `heavy-timeline-perf`, `diff-open-perf`) passed.

RAN, wave 2 (the full app gate list): `CONFORMANCE_FAIL checks=15 failed=4 wall=79.8s`. Passed:
composer, scrollview-onscroll, composer-voice-gesture, focus-geometry, focus-measure, markdown,
ws-replay-storm, tabs, terminal-keys, glass, boot. Failed: `feed-legendlist-scroll` (9.77s),
`stage-surface` (5.71s), `pane-focus` (30.16s), `terminal-enter` (66.10s).

Triage of the four:

- `pane-focus` and `stage-surface` are the same app-side fixture drift: the gates look nodes up by
  display title while the fixtures label by slug. `pane-focus` is already documented in the app
  lane's own report; `stage-surface` fails on `no node matched "Session timeline"` and is the same
  family, undocumented. App scope, not mine.
- `terminal-enter` fails on a backend error, `ServerOverloaded` and
  `Orez HTTP cookie is not numeric: 00000000000undefined`, and the app report already flags it as an
  engine-owner gap. Its 66.10s wall is consistent with backend retry, so I do not read the failure as
  engine-side.
- `feed-legendlist-scroll` is the load-bound gate above.

No app gate failed in a way I could attribute to the engine.

## Review: the Muse desktop changes make no incorrect engine assumptions

Read from `/Users/n8/team-machine`, read-only, on the three commits that carry today's desktop work.
`qa/desktop-engine-integration` has no commits `main` does not, so the assembled boundary is `main`
itself. Verdict: ACCEPT, no findings returned.

- `692c63172` adds `selectable` beside `select="text"` at 36 desktop text sites. READ, and this is the
  change that most needed checking, because the commit's own reasoning is about the web: on web `select`
  is shorthand for `userSelect`, so `select="text"` already selects there. The engine implements
  selection for the RN `selectable` prop only — `ts/src/reconciler.ts:1170` sets `node.selectable` from
  `props.selectable === true`, and `grep -rn "userSelect|user_select|UserSelect" rust/src ts/src`
  returns nothing at all. So `select="text"` is a silent no-op here and the added prop is the one the
  engine reads. Correct.
- The nested shape in that same commit (an outer selectable `SizableText` wrapping an inner plain one,
  `RightPanel.tsx:348`, `:373`) is only sound if the outer's own text and layout contain the
  inner run's glyphs. READ: `gatherRuns` walks the `<Text>` tree into flowing runs and the parent's
  string is their concatenation (`ts/src/reconciler.ts:1042,1163-1170`), so a press anywhere in the
  parent hitbox anchors a selection covering the nested run. Now also TESTED, by the gate below.
- `1e8540826` submits the composer on Enter when `IS_GPUI_DESKTOP`. READ both halves of the contract:
  the engine's key payload carries `key`, `shiftKey`, `ctrlKey`, `metaKey` and `isComposing` on the event
  and on `event.nativeEvent` (`ts/src/reconciler.ts:763-784`), which is the access pattern the app uses,
  and a real Enter is emitted as the string `"Enter"` with the Input's live IME state
  (`rust/src/service.rs:130-133,1784`). `state.key === 'Enter'` therefore matches. One overlap worth
  knowing rather than a defect: for a multiline Input the engine also strips the submit newline itself
  after emitting the key (`service.rs:1797`), so both layers act on the same keystroke.
- The mobile commit `475783611` (`OverviewGridList.native.tsx`, React Compiler bailouts) is out of this
  review's scope: `.native.tsx` is the mobile variant of a file that has a `.desktop.tsx` sibling, the
  desktop renderer is what this engine drives, and the change moves a render-phase ref write into an
  effect, which is a React question and not an engine contract.

## The `<Text selectable>` drag selection had no coverage at all; it has a gate now

`grep -rn "selectable" ts/examples ts/scripts` returned nothing before this change: the engine's
selection feature, which the app now marks 36 desktop sites with, was untested here. Since the review
above turns on the nested-run shape, the source reading was not enough on its own.

Three pieces, one slice:

- `selectedText` on the control socket, answered by the main loop as an `Incoming` rather than from the
  socket thread. That is not a style choice: `selection` keeps its registry in a `thread_local`
  ("Everything lives on the main thread (gpui is single-threaded)", `rust/src/selection.rs:12`), so a
  socket-thread read would answer `None`, which is indistinguishable from "nothing is selected". The
  reply carries the text and the live region bounds.
- `ts/examples/selection-conformance.tsx`: `sel-plain` (a selectable Text), `sel-nested` (a selectable
  Text whose text lives in a nested Text, the app's shape at `RightPanel.tsx:348` and `:373`), and
  `sel-none` (no `selectable`), with a unique word per site.
- `ts/scripts/text-selection-conformance.mjs`, in the suite as `text-selection` (1.5s standalone,
  2.9s in suite).

RAN: `TEXT_SELECTION_CONFORMANCE PASS plain="phaplain one two three" nested="etalead: betanestedfourfive
six" unselectable=null`. The nested reading is the one that matters: it spans the outer's own text
(`etalead: `) and the nested run's glyphs (`betanestedfourfive six`), and the assertion keys on "six",
which the outer's own string does not contain. The negative control is what lets that count: the readout
answers `null` for a Text without the prop, so a readout that leaked a neighbouring row's text would not
pass. The gate also asserts the three sites are three distinct rows and that a press dismisses the
previous selection, so each case is independent.

Two things it cost to get right, both about which driver command reaches which listener path:

- The synthetic `tap` does not dismiss a selection. Dismissal is the capture-phase mousedown in
  `wire_native_selection` (`rust/src/elements/text.rs:444-457`), and `tap` "invokes handlers straight off
  the tree" without going through gpui's event loop (`rust/src/service.rs:120`), so the clear never
  ran and the next case read the previous one's text. `realtap` goes through
  `dispatch_real_input`, and the gate asserts the dismissal took effect rather than assuming it.
- The first version asserted the selection starts at the row's first character. A drag anchors where the
  press lands, so 2% into the row is mid-word and it read `phaplain one two three`. The assertion now
  keys on a token that identifies the SITE rather than the start offset.

## The scroll path is display-paced, not engine-bound: sampled profile and retained-layout participation

Two measurements of the same workload the memory work used, a 100k list driven through 400 wheel events
at 96px. Both RAN.

The profile (`/usr/bin/sample`, 1ms, asked for 10s and got 7930 samples covering the whole burst plus
about 1s of tail): the main thread is 26.6% busy, and of its leaves 5818 of 7930 samples are blocked in
`mach_msg2_trap` with another 781 in `CAMetalLayerPrivateNextDrawableLocked` waiting on a drawable. The
single largest engine cost is therefore waiting for the display pipeline, not engine CPU. What engine
CPU there is spreads thin: `_platform_memmove` 98, `bounds_tree::find_max_ordering` 30,
`Scene::insert_primitive` 18, `TextSystem::line_wrapper` 9, `taffy flexbox` 9 — no symbol above 1.2% of
the window. The JS thread is the striking part: 7529 of 7930 samples parked in
`flume::Shared::recv`, i.e. ~90% idle across a scroll that moved the list from item 0 to item 940, with
its ~400 busy samples almost all engine-side dispatch (`dispatch_coalesced` → `call1` →
`JSObjectCallAsFunction`, then JSC draining microtasks). A wheel scroll does not round-trip through app
JS per event.

The burst is asserted to have scrolled (top visible item 0 → 940 before the profile is read), because a
profile of a scroll that never happened has the same shape as one that did. The first version of this
probe lacked that assertion and was re-run to add it.

Retained-layout participation over the same burst, from `RNGPUI_DRAW_PROBE` + `RNGPUI_RETAINED_TRACE`:
458 frames in 3805ms of driving (120 frames/s), of which only 58 reused the prior layout and 400 ran a
full layout. The state line explains the 400 rather than leaving it as a defect:
`paint_only=true want_reuse=false reusing=false | root_dirty=true layout_dirty=false`. Want-reuse needs
`root_allows_reuse`, i.e. `!root_dirty || (root_paint_only && paint_only)` (`service.rs:1654`), and a
virtualized list mounting and unmounting rows makes the React tree genuinely different every frame, so
the veto is correct. It is also cheap: those full-layout frames are p50 1.41ms / p90 1.95ms, because
only the mounted rows are solved. The existing `scroll-settle-retained` gate covers a geometry-stable
fixture where reuse does engage; this run says the two are consistent, not contradictory (a small
non-virtualized scroll stays structurally identical, a virtualized one does not).

Control: the same burst with `RNGPUI_DISABLE_RETAINED_LAYOUT=1` gave 471 frames at 118.9 frames/s, all
full layout, unchanged throughput. I am not reading its p50 2.22ms against the p50 1.41ms of the enabled
run as the fast path's effect, because the two runs settle at different scroll offsets and mount
different rows; it would need a position-matched pair, and throughput being flat across both says the
fast path is not this fixture's limit either way. No engine defect is claimed from any of this.

## Resolved: `legend-list-100k` footprint budgets are decided by when they sample, not by what the engine holds

RAN, `conformance:legend-100k`, three times with numbers and once more failing before any
measurement. Every run with numbers fails the same assertion and nothing else in the memory block is
close: settled footprint delta 79MB, 74MB and 88MB against a 64MB budget, max delta 147MB, 141MB and
155MB against 110MB, RSS load delta 76.5MB and 80.6MB. The structural assertions pass in every run,
`maxNativeNodes` 126-141 against a budget of 250, and mounted rows stay under 80. The most recent
report is the one the rest of this section measures against: reference 302MB at paint, afterLoad
381MB, afterFarJumps 446MB, afterScroll 449MB.

One invocation failed before any measurement with `window did not appear`. Its service log
stops at `[startup] pre open_window +137.9ms` and never advances, so the window was never created.
One occurrence, not reproduced in the runs after it; `cli/host.ts:361` deliberately keeps that
workdir for exactly this, and the log is the only evidence there is.

The fixture hands LegendList one shared sentinel for all 100,000 items
(`examples/legend-list-100k.tsx:23`), so its own data array is ~0.8MB at any count, while the
reference process that produces the baseline runs the same fixture with 0 items. The engine's
per-item surface cannot carry the difference either: the native tree holds 126 to 136 nodes at every
sample, and the nine far jumps between 0, 50,000 and 99,999 add only the ~15 rows mounted at each
landing. The gate's most recent upstream change is `57db024 feat(runtime): replace Hermes with
JavaScriptCore`, so its 64MB budget was last set before the runtime's heap model changed.

RAN, a scaling run across item counts. A scratch copy of the fixture with `ITEM_COUNT` read
from the environment, settled footprint against the same empty reference: 10,000 items 163MB (+19MB),
25,000 171MB (+27MB), 50,000 174MB (+30MB), 100,000 214MB (+70MB), reference 144MB. The cost is not
proportional to item count, and three of the four counts are inside the 64MB budget: the excess
appears between 50,000 and 100,000. Native nodes are 126 at every count.

RAN, the forced collection, now that the engine has one (`df733e4`). It frees 0.0MB of footprint at
every settled point: after the 100k load (215MB), and after the gate's own workload of twelve far
jumps and 160 paced wheel events (289-293MB). Two consecutive collections free nothing. There is
still no JS-side heap readout, so the settled 72MB cannot be split between LegendList's own metadata
and JSC heap pages; the control socket can now force a collection but cannot report heap size.

TESTED, and this is the part that decides the finding: a forced collection cannot make physical
footprint able to tell live memory from freed memory. 190MB of JS doubles were allocated through
`evalJs`, both references dropped, and the collection called: footprint went 483MB to 480MB. Freed JS
pages are not returned to the OS, so the 0.0MB freed above is not evidence that the memory is live,
and the same reading disqualifies the settled delta itself. That delta is 79MB at paint and 70-72MB
after both processes settle, because each sheds about 160MB on its own with no intervention (target
376MB to 215MB, reference 302MB to 143MB). The budget is red either way; roughly 160MB of each
sample is transient. The reference is exposed to this too, which is why its paint reading moved
between 208MB and 302MB across runs while its settled reading held at 143-144MB.

RAN, a leak test, because a plateau and a leak are different verdicts. Five identical 160-wheel
bursts, settled footprint after each: 274, 302, 320, 320, 319MB. Growth stops at the third burst, RSS
plateaus with it (389MB), and native nodes hold at 141 through all 800 wheel events. That is a
bounded warm-up.

VERDICT: no engine defect is proven, and the budget cannot support one. The engine's native retention
is constant at 126-141 nodes across 100,000 items, twelve far jumps and 800 wheel events, and the
footprint shows a bounded warm-up rather than a leak. What the assertion measures is the difference
between two transients sampled at the instant `loaded:` paints, on a metric that does not fall when
JS memory is freed (measured above). The change that follows, not made here: sample the settled state
after the footprint stops changing and assert on something that responds to freeing, keeping 64MB if
that is the product budget. That re-specifies a gate's verdict semantics and the budget's intent is
not mine to decide, so the gate is untouched and still red, now for a measured reason rather than an
unattributed 79MB.

The engine capability landed anyway (`df733e4`): `collectGarbage` over the control socket, collecting
both runtimes, with a selftest that proves it collects through `WeakRef.deref()` and a negative
control that fails when the collect is replaced by `return 0`.

## Remaining gaps

- Dialog finding: the first-mapper-frame probe named above. Until then the driver-side start value is
  located by reading, not by observation.
- Perf-shaped measurements carry a caveat, not a skip. Load held 18.6 (1m) / 29.3 (5m) / 25.4 (15m)
  during wave 1 and rose to 38.91 later, against the app's own requirement of a clean load under 9.0.
  The checks above are evidence that the surfaces work; they are not evidence of any latency number.
  These need a clean-load re-run: `session-drag`, `session-pingpong`, `session-scrub`, `tab-switch`,
  `native-timeline-scroll`, `desktop-interaction-perf`, `controlroom-terminal-pingpong`.
- Of the two engine-lane entries in that list, `startup-conformance` now has both readings it was
  missing (warm at loadavg 10.5-11.1: 88-136ms internal, PASS, twice; coldest launch after idle:
  201ms internal / 236ms wall, FAIL) and so is characterized rather than merely unrun.
  `input-runtime`'s focus latency is characterized too, and the answer is that this machine cannot
  produce its verdict: at a window opening on 48.85% idle the gate reads median 21.02/p95 66.19ms
  while the twin probe reads median 15.45ms in the same window. The gate's p95 is the second largest
  of twenty samples, so one stall decides it, and the median it also prints is genuinely over budget.
  Recorded above; no change made to the assertion, the sample count, or the engine.
- Triage sweep status. PASS: `anim-overlay`, `card-corner-shadow`, `check-transform`, `context-menu`,
  `describe`, `webview-overlay`, `drive`, `reanimated-scroll`, `reanimated`, `sustained-reanimated`,
  `scroll-performance` (`p95=7.83ms latencyP95=13.13ms moved=1530px`), `presentation-pacing`
  (`paintP50=8.32ms paintP95=9.23ms presentOver12.5=1`), `native-scroll-react-stall` (3/3 after
  `28da8b4`). FAIL and fixed: `card-corner-shadow` (blank capture, `06ac787`), `input-runtime` (stale
  scale, `3cfab6c`), `native-scroll-react-stall` (window race, `28da8b4`). FAIL and open in another
  lane: `dialog-reanimated`. FAIL and open here, resolved rather than fixed: `legend-list-100k`, in
  its own section above (no engine defect proven; the footprint budget's metric cannot decide
  liveness, and its sample instant is a transient). Nothing is now untriaged. `conformance-utils.mjs`
  is a helper, not a gate. The `AGENTS.md` Display P3 caveat applies to any color assertion;
  measured drift was `#f2c84b` rendering as `#ebc864` and `#ff4fa3` as `#eb5fa0`, 23-29 per channel.
- `RNGPUI_DRAW_PROBE` and `RNGPUI_SCROLL_LATENCY_PROBE` are live, not stale: the vendored GPUI reads
  them at `rust/vendor/gpui-0.2.2-patched/src/window.rs:2043` and `:2182`. A `rust/src`-only search
  says they have no consumer, which is wrong, so search `rust/vendor` before calling any probe env
  var dead.
- `npm test` is 42 tasks, with the new `jsc-shim` and `text-selection` checks inside it. `input` fails
  deterministically (3/3 standalone, and in every suite run): it resolves an AX element index from the
  window's tree, then the next `cua-driver call type_text` fails with `Element index 1 not found. Call
  get_window_state first.` Two environment facts explain it and neither is this change. `cua-driver
  status` reports no daemon running, so nothing carries the resolved index between two CLI invocations,
  and `plans/HANDOFF.md:206` already records that AX-by-index does not work here because the tree reads
  empty, with pixel driving as the documented route; the harness also keeps its windows offscreen
  (`assertWindowOffscreen`). The engine does publish an AX tree (`rust/src/ax.rs`), so this is not a
  missing engine feature either. Not fixed: converting an input gate to pixel driving is a harness
  change, and whether a non-offscreen window is allowed here is not this lane's call.
- `input-visual` failed once in six suite runs, and I could not characterize it. It passes 3/3
  standalone, passed the other five suite runs including the two immediately after (42 tasks each), and
  passes standalone under four and then six CPU burners, so simple starvation does not explain it. The
  failing run's output was not captured, which is my error: I filtered the first suite run with `grep`
  instead of saving it. Its two waits are wall-clock bounds a loaded machine could cross (a 3000ms
  socket timeout at `ts/scripts/input-visual-conformance.mjs:141` and a 7000ms deadline for the first
  capture at `:173`), which is the failure class I would expect, but I did not observe it and I am not
  claiming it. It is also not attributable to the `text-selection` gate that joined the suite in that
  same run: any change to the task list reshuffles which eight tasks run concurrently, and I have only
  that one observation against five clean ones. The earlier "40/41, only `input`" reading was itself a
  single run, so a low-rate pre-existing flake is not excluded either. Reproduce it and read the output
  before treating this as anything.
- The gate names in the earlier note (`conformance:box-model` and friends) do not exist: this repo
  defines no `conformance:` npm scripts, and no box-model gate at all. The real files are
  `ts/scripts/*-conformance.mjs`. Two of the three names in that note were the two defects above.
- `plans/HANDOFF.md` still describes the single-process Hermes design and is stale after the
  JavaScriptCore swap. Left alone: another lane's document.

## Corrections to earlier reasoning in this lane

Recorded because the wrong version is plausible enough to be reused.

- I claimed the UI runtime's `process.env` is empty, and built an argument on it. WRONG.
  `rust/src/jsc.rs:1183-1188` gives the UI runtime the full `std::env::vars()`, and base `2555170`
  did the same at lines 1075 and 1158. `561d1fc` never touched that code. Diagnostics such as
  `RNGPUI_SEAM_DEBUG` are reachable from the UI runtime, which is consistent with the seam debug
  output this file relies on.
- I claimed the negative control `RNGPUI_FOCUS_VISIBLE_INITIAL` does not exist and that this file
  asserted a control that was never written. WRONG, and the near-miss is the useful part: my grep
  covered `ts/src` only, and the variable is read by the fixture at
  `ts/examples/focus-visible-conformance.tsx:46`. Absence of a hit in a narrow scope is not absence.
- I waited 45 minutes for a clean window on `loadavg(1m) < 9` and called the machine busy when it
  expired. The wait was the wrong instrument, and the busy part was beside the point: `top` reported
  19-41% idle at loadavg 30 and 43.9% idle at loadavg 49.6, and the batch that red at loadavg 8.82 was
  followed by two batches that passed at 10.5 and 11.1. Load average counts runnable threads on this
  box and barely tracks available CPU, so a wait keyed on it can expire while a third of the machine
  is idle and can succeed while a cold launch is slow. Sample CPU idle instead
  (`ts/scripts/quiet-window.sh`), and do not read a load number as a capacity claim.
