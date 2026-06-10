// requestAnimationFrame: under the gpui host BOTH runtimes get the real
// vsync-driven implementation from rust/src/hermes_preamble.js (frame_clock.rs /
// CVDisplayLink — armed via __rngpui_requestFrame, fired as __rngpui_fireFrame
// once per display refresh). That preamble evaluates before any bundle, so by the
// time this module loads, rAF already exists and this file does nothing.
//
// Outside the host (bun unit tests) there is no preamble; keep a 16ms timer shim
// so animation code stays runnable in tests.

const root = globalThis as typeof globalThis & {
    requestAnimationFrame?: (callback: FrameRequestCallback) => number;
    cancelAnimationFrame?: (id: number) => void;
};

if (typeof root.requestAnimationFrame !== "function") {
    root.requestAnimationFrame = (callback) =>
        setTimeout(() => callback(typeof performance !== "undefined" ? performance.now() : Date.now()), 16) as unknown as number;
    root.cancelAnimationFrame = (id) => clearTimeout(id);
}
