#!/usr/bin/env bun
/**
 * pure-js unit test for the Animated driver (no gpui capture). covers the two
 * driver bugs that used to make motion dead: Animated.loop never repeating, and
 * Easing curves all being identity. runs in milliseconds, so it works in the
 * sandbox where the gpui-capture conformance is clamped off-screen.
 *
 * Animated.ts binds `raf`/`caf` at module-load time from globalThis (falling back
 * to a setTimeout shim when absent — which is what bun has). so to drive the
 * timing path off a deterministic manual clock we install a controllable
 * requestAnimationFrame/cancelAnimationFrame + performance.now on globalThis
 * BEFORE importing the module, then dynamic-import so the bindings pick up our
 * fakes. without this, the looped-timing oscillation can't be exercised here.
 */

// --- controllable manual clock (installed before the module binds raf) -------
let now = 0;
const rafQueue = new Map();
let nextRafId = 1;
globalThis.requestAnimationFrame = (cb) => {
    const id = nextRafId++;
    rafQueue.set(id, cb);
    return id;
};
globalThis.cancelAnimationFrame = (id) => {
    rafQueue.delete(id);
};
const realPerfNow = performance.now.bind(performance);
performance.now = () => now;
// pump every currently-queued raf callback with the current clock, then return
// how many fired. callbacks scheduled during the pump run on the NEXT pump.
function pumpFrame() {
    const pending = [...rafQueue.entries()];
    rafQueue.clear();
    for (const [, cb] of pending) cb(now);
    return pending.length;
}

const { Animated, Easing } = await import("../src/Animated.ts");

let failed = false;
function check(name, ok, detail = "") {
    const status = ok ? "PASS" : "FAIL";
    console.log(`UNIT_${status} ${name}${detail ? ` ${detail}` : ""}`);
    if (!ok) failed = true;
}

// --- loop actually repeats -------------------------------------------------
// use a synthetic inner animation that finishes synchronously on start(), so we
// directly observe how many times loop() re-runs it. iterations:3 must fire it
// exactly 3 times and then report finished.
{
    let starts = 0;
    const counting = {
        start(cb) {
            starts += 1;
            cb?.({ finished: true });
        },
        stop() {},
        reset() {},
    };
    let finished = false;
    Animated.loop(counting, { iterations: 3 }).start(({ finished: f }) => {
        finished = f;
    });
    check("loop-repeats", starts === 3, `starts=${starts} (want 3)`);
    check("loop-finishes", finished === true, `finished=${finished}`);
}

// infinite loop (default) must not report finished, and stop() must halt it.
// the inner stalls after 6 starts (simulating an in-flight animation) so we can
// call stop() and confirm no further restarts and no finished callback.
{
    let starts = 0;
    let finishedCalled = false;
    const inner = {
        start(cb) {
            starts += 1;
            if (starts < 6) cb?.({ finished: true });
        },
        stop() {},
        reset() {},
    };
    const looped = Animated.loop(inner);
    looped.start(() => {
        finishedCalled = true;
    });
    const startsBeforeStop = starts;
    looped.stop();
    check("loop-infinite-restarts", starts >= 5, `starts=${starts} (want >=5)`);
    check("loop-infinite-no-finish", finishedCalled === false, `finishedCalled=${finishedCalled}`);
    check("loop-infinite-stop-halts", starts === startsBeforeStop, `startsAfterStop=${starts}`);
}

// --- looped timing keeps oscillating (the real RepaintPump fix) ------------
// run a 100ms linear timing inside loop() and pump the manual clock at ~16ms.
// the bug: each looped iteration re-read the now-settled value as `from`, so
// iteration 2+ animated 1->1 (no motion) and the offscreen window went stale.
// with reset() rewinding to the start value, the value must return to ~0 at the
// top of every iteration and reach ~1 at the bottom, repeatedly.
{
    now = 0;
    rafQueue.clear();
    const value = new Animated.Value(0);
    const looped = Animated.loop(Animated.timing(value, { toValue: 1, duration: 100, easing: Easing.linear }));
    looped.start();

    const samples = [];
    // pump enough frames to cover several 100ms iterations.
    for (let i = 0; i < 60; i++) {
        pumpFrame();
        samples.push(value.__getValue());
        now += 16;
    }
    looped.stop();

    const maxV = Math.max(...samples);
    const minV = Math.min(...samples);
    // count fresh ramps: each time the value crosses 0.9 going up is a new cycle.
    let ramps = 0;
    for (let i = 1; i < samples.length; i++) {
        if (samples[i - 1] < 0.9 && samples[i] >= 0.9) ramps += 1;
    }
    check("loop-timing-reaches-top", maxV >= 0.95, `max=${maxV.toFixed(3)}`);
    check("loop-timing-returns-to-bottom", minV <= 0.05, `min=${minV.toFixed(3)}`);
    check("loop-timing-multiple-ramps", ramps >= 2, `ramps=${ramps} (want >=2)`);

    // stop() must truly halt: pumping more frames after stop changes nothing.
    const afterStop = value.__getValue();
    for (let i = 0; i < 10; i++) {
        pumpFrame();
        now += 16;
    }
    check("loop-timing-stop-halts", value.__getValue() === afterStop, `before=${afterStop} after=${value.__getValue()}`);
}

// restore the real perf clock for any downstream tooling.
performance.now = realPerfNow;

// --- easing curves are real (non-identity) ---------------------------------
const at = 0.25;
check("easing-quad-nonidentity", Easing.quad(at) !== at, `quad(0.25)=${Easing.quad(at)}`);
check("easing-cubic-nonidentity", Easing.cubic(at) !== at, `cubic(0.25)=${Easing.cubic(at)}`);
check("easing-ease-nonidentity", Easing.ease(at) !== at, `ease(0.25)=${Easing.ease(at)}`);
check("easing-linear-identity", Easing.linear(at) === at, `linear(0.25)=${Easing.linear(at)}`);

// quad: in is below diagonal, out is above, both pinned at endpoints.
check("easing-quad-in-below", Easing.in(Easing.quad)(0.5) < 0.5, `in(0.5)=${Easing.in(Easing.quad)(0.5)}`);
check("easing-quad-out-above", Easing.out(Easing.quad)(0.5) > 0.5, `out(0.5)=${Easing.out(Easing.quad)(0.5)}`);
check(
    "easing-endpoints",
    Math.abs(Easing.quad(0)) < 1e-9 && Math.abs(Easing.quad(1) - 1) < 1e-9,
    `quad(0)=${Easing.quad(0)} quad(1)=${Easing.quad(1)}`,
);

// inOut: symmetric, midpoint == 0.5, first half = f(2t)/2.
const io = Easing.inOut(Easing.quad);
check("easing-inout-mid", Math.abs(io(0.5) - 0.5) < 1e-9, `inOut(0.5)=${io(0.5)}`);
check("easing-inout-symmetry", Math.abs(io(0.25) + io(0.75) - 1) < 1e-9, `io(0.25)=${io(0.25)} io(0.75)=${io(0.75)}`);
check("easing-inout-firsthalf", Math.abs(io(0.25) - Easing.quad(0.5) / 2) < 1e-9, `io(0.25)=${io(0.25)}`);

// the spec's canonical guard: inOut(cubic)(0.25) must be non-identity and equal
// cubic(2*0.25)/2 = cubic(0.5)/2 = 0.125/2 = 0.0625. (identity-era code returned 0.25.)
const ioCubic = Easing.inOut(Easing.cubic)(0.25);
check("easing-inout-cubic-nonidentity", ioCubic !== 0.25, `inOut(cubic)(0.25)=${ioCubic}`);
check("easing-inout-cubic-value", Math.abs(ioCubic - 0.0625) < 1e-9, `inOut(cubic)(0.25)=${ioCubic} (want 0.0625)`);

if (failed) {
    console.error("ANIMATED_DRIVER_UNIT_FAIL");
    process.exit(1);
}
console.log("ANIMATED_DRIVER_UNIT_PASS");
