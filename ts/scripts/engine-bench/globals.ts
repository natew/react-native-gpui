// Imported FIRST by every bench entry, before react/react-reconciler module init, so the
// scheduler captures THESE and every engine runs the identical amount of work.
//
// React's scheduler picks setImmediate > MessageChannel > setTimeout. Under bun/JSC the
// real MessageChannel would hand work to the host loop we never yield to, so we define
// setImmediate and erase MessageChannel: all scheduled work lands in our own queues and
// drain() is the only thing that runs it. That is what makes bytecode, native, and JSC
// runs comparable rather than three different schedulers.
const g = globalThis as any;
const micro: Array<() => void> = [];
const macro: Array<() => void> = [];

g.__micro = micro;
g.__macro = macro;
g.__bytes = 0;
g.__calls = 0;

g.queueMicrotask = (cb: () => void) => { micro.push(cb); };
g.setTimeout = (cb: () => void) => { macro.push(cb); return 0; };
g.clearTimeout = () => {};
g.setImmediate = (cb: () => void) => { macro.push(cb); return 0; };
g.clearImmediate = () => {};
g.MessageChannel = undefined;
g.setInterval = () => 0;
g.clearInterval = () => {};
g.requestAnimationFrame = (cb: (t: number) => void) => { macro.push(() => cb(0)); return 0; };
g.cancelAnimationFrame = () => {};
if (!g.performance) g.performance = { now: () => Date.now() };

// stand in for the Rust host: count what would have crossed the bridge.
g.__rngpui_applyTree = (json: string) => { g.__bytes += json.length; g.__calls++; };
g.__rngpui_now = () => Date.now();

g.process = g.process || { env: {} };
g.process.env = g.process.env || {};
// flip to "1" for rngpui's per-phase breakdown (mutation / serialize / delta /
// stringify / bridge) printed once per commit. Off by default: the trace's own
// performance.now() calls are visible at this commit size.
g.process.env.RNGPUI_COMMIT_TRACE = "";

const out: (s: string) => void = g.print || ((s: string) => g.console && g.console.log(s));
g.__out = out;
g.console = g.console || { log: out, error: out, warn: out, debug: () => {} };
if (!g.console.error) g.console.error = out;

export function drain(): void {
    for (let i = 0; i < 100000; i++) {
        if (micro.length) { micro.shift()!(); continue; }
        if (macro.length) { macro.shift()!(); continue; }
        return;
    }
    throw new Error("drain: scheduler did not settle");
}

export function report(label: string, commits: number, rows: number, ms: number): void {
    out(
        "BENCH " + label +
        " commits=" + commits +
        " rows=" + rows +
        " ms=" + ms +
        " perCommitMs=" + (ms / commits).toFixed(3) +
        " applyTreeCalls=" + g.__calls +
        " wireBytes=" + g.__bytes,
    );
}
