// `rngpui trace` — record an animation's actual per-frame values, no screenshots.
//
//   rngpui trace dialog --action "tap open-button" --ms 1200 --session <dir>
//   rngpui trace --all --keys opacity,transform --ms 800 --attach
//
// Arms an in-service trace session (traceStart), optionally fires input actions, waits,
// then collects (traceStop) every off-thread reanimated style write and NativeLayout
// tween tick that landed in the window — each tagged with a wall-clock timestamp and the
// painted-frame counter. The analysis proves the three things a screenshot can't:
// cadence (per-sample gaps + dropped frames), curve shape (sparkline; spring overshoot
// is visible), and endpoints (first → last value).

import { isDriveableHost, type AttachedHost, type DumpNode, type LaunchedHost } from "../host";
import { sleep } from "../../scripts/conformance-utils.mjs";
import { centerOf, parsePoint, resolve } from "../selectors";

type Host = LaunchedHost | AttachedHost;

export interface TraceOptions {
    json: boolean;
    /// style keys to record (default: all)
    keys?: string[];
    /// observation window after actions fire
    ms: number;
    /// input actions to fire right after arming: "tap <selector>", "key <key>", "type <text>"
    actions: string[];
    /// trace all nodes instead of resolving selectors
    all: boolean;
}

type Sample = { t: number; f: number; id?: number; nativeKey?: string; k: string; v: unknown };
type StopResponse = {
    ok: boolean;
    error?: string;
    durationMs: number;
    framesPainted: number;
    paintGapsMs: number[];
    truncated: boolean;
    samples: Sample[];
};

export async function runTrace(host: Host, selectors: string[], opts: TraceOptions): Promise<number> {
    if (!isDriveableHost(host)) {
        console.error("  trace needs a driveable target: --launch, --bundle, --session, or a control-socket attach");
        return 1;
    }
    const driveable = host;

    // resolve selectors → the matched nodes' whole subtrees. Animated style usually
    // lands on an inner wrapper (Dialog.Content, a presence wrapper), not the node
    // carrying the testID, so the subtree is the useful unit.
    let ids: number[] | undefined;
    let nativeKeys: string[] | undefined;
    const labels: string[] = [];
    if (!opts.all && selectors.length > 0) {
        const dump = await driveable.dump();
        const idSet = new Set<number>();
        const nativeSet = new Set<string>();
        for (const selector of selectors) {
            const { best } = resolve(dump, selector);
            if (!best) {
                console.error(`  no node matched "${selector}"`);
                return 1;
            }
            labels.push(`${selector} → #${best.node.globalId}`);
            collectSubtree(best.node, idSet, nativeSet);
        }
        ids = [...idSet];
        nativeKeys = nativeSet.size > 0 ? [...nativeSet] : undefined;
    }

    const start = await driveable.request<{ ok: boolean; error?: string }>({
        $cmd: "traceStart",
        ...(ids ? { ids } : {}),
        ...(opts.keys ? { keys: opts.keys } : {}),
        ...(nativeKeys ? { nativeKeys } : {}),
        maxMs: opts.ms + 5_000,
    });
    if (!start.ok) {
        console.error(`  traceStart failed: ${start.error || "unknown"}`);
        return 1;
    }

    for (const action of opts.actions) {
        const error = await fireAction(driveable, action);
        if (error) {
            await driveable.request({ $cmd: "traceStop" });
            console.error(`  action "${action}" failed: ${error}`);
            return 1;
        }
    }

    await sleep(opts.ms);

    const stop = await driveable.request<StopResponse>({ $cmd: "traceStop" });
    if (!stop.ok) {
        console.error(`  traceStop failed: ${stop.error || "unknown"}`);
        return 1;
    }

    const series = buildSeries(stop.samples);
    const analysis = series.map(analyzeSeries);

    if (opts.json) {
        console.log(
            JSON.stringify(
                {
                    tracedNodes: labels,
                    durationMs: stop.durationMs,
                    framesPainted: stop.framesPainted,
                    truncated: stop.truncated,
                    series: analysis,
                    samples: stop.samples,
                },
                null,
                2,
            ),
        );
        return 0;
    }

    const paintLine = paintCadence(stop.paintGapsMs);
    console.log(`  traced ${Math.round(stop.durationMs)}ms — ${stop.framesPainted} frames painted${paintLine}`);
    for (const label of labels) console.log(`  ${label}`);
    if (stop.truncated) console.log("  WARNING: sample buffer overflowed — series are incomplete");
    if (analysis.length === 0) {
        console.log("  no animated values recorded — nothing wrote styles/native-layout frames in the window");
        return 0;
    }
    for (const s of analysis) {
        if (s.kind === "numeric") {
            const dropped = s.droppedGaps > 0 ? `, ${s.droppedGaps} dropped-frame gaps` : "";
            const overshoot = s.overshoots > 0 ? `, overshoots final ×${s.overshoots} (springy)` : "";
            console.log(`  ${s.key}  ${s.first} → ${s.last}  [${s.min}..${s.max}]`);
            console.log(
                `    ${s.spark}  ${s.count} samples over ${Math.round(s.spanMs)}ms (~${s.sampleHz}Hz${dropped}${overshoot})`,
            );
        } else {
            console.log(`  ${s.key}  ${s.count} writes: ${s.first} → ${s.last}`);
        }
    }
    return 0;
}

function collectSubtree(node: DumpNode, ids: Set<number>, nativeKeys: Set<string>) {
    ids.add(node.globalId);
    const key = (node as { nativeLayoutKey?: string }).nativeLayoutKey;
    if (key) nativeKeys.add(key);
    for (const child of node.children ?? []) collectSubtree(child, ids, nativeKeys);
}

async function fireAction(
    driveable: { dump(): Promise<DumpNode>; request<T>(cmd: object): Promise<T> },
    action: string,
): Promise<string | null> {
    const [verb, ...rest] = action.trim().split(/\s+/);
    const arg = rest.join(" ");
    if (verb === "tap") {
        let x: number, y: number;
        const pt = parsePoint(arg);
        if (pt) {
            ({ x, y } = pt);
        } else {
            const dump = await driveable.dump();
            const { best } = resolve(dump, arg);
            if (!best) return `no node matched "${arg}"`;
            const center = centerOf(best.node);
            if (!center) return `node #${best.node.globalId} has no bounds`;
            ({ x, y } = center);
        }
        const r = await driveable.request<{ ok: boolean; error?: string }>({ $cmd: "tap", x, y });
        return r.ok ? null : r.error || "tap failed";
    }
    if (verb === "key") {
        const r = await driveable.request<{ ok: boolean; error?: string }>({ $cmd: "key", key: arg });
        return r.ok ? null : r.error || "key failed";
    }
    if (verb === "type") {
        const r = await driveable.request<{ ok: boolean; error?: string }>({ $cmd: "type", text: arg });
        return r.ok ? null : r.error || "type failed";
    }
    return `unknown action verb "${verb}" (tap/key/type)`;
}

type Point = { t: number; f: number; val: number };
type Series =
    | { kind: "numeric"; key: string; points: Point[] }
    | { kind: "discrete"; key: string; values: { t: number; v: string }[] };

/// Flatten raw samples into per-(node,key) series. Numbers chart; transform arrays
/// explode into per-component numeric series; everything else is a discrete log.
function buildSeries(samples: Sample[]): Series[] {
    const numeric = new Map<string, Point[]>();
    const discrete = new Map<string, { t: number; v: string }[]>();
    const push = (key: string, t: number, f: number, v: unknown) => {
        if (typeof v === "number") {
            let arr = numeric.get(key);
            if (!arr) numeric.set(key, (arr = []));
            arr.push({ t, f, val: v });
            return;
        }
        let arr = discrete.get(key);
        if (!arr) discrete.set(key, (arr = []));
        arr.push({ t, v: JSON.stringify(v) });
    };
    for (const s of samples) {
        const base = s.nativeKey ? `${s.nativeKey}(native)` : `#${s.id}`;
        if (s.k === "transform" && Array.isArray(s.v)) {
            for (const part of s.v) {
                if (part && typeof part === "object") {
                    for (const [tk, tv] of Object.entries(part)) push(`${base}.transform.${tk}`, s.t, s.f, tv);
                }
            }
            continue;
        }
        if (s.nativeKey && s.v && typeof s.v === "object") {
            for (const [fk, fv] of Object.entries(s.v)) push(`${base}.${fk}`, s.t, s.f, fv);
            continue;
        }
        push(`${base}.${s.k}`, s.t, s.f, s.v);
    }
    const out: Series[] = [];
    for (const [key, points] of numeric) out.push({ kind: "numeric", key, points });
    for (const [key, values] of discrete) out.push({ kind: "discrete", key, values });
    out.sort((a, b) => a.key.localeCompare(b.key));
    return out;
}

const SPARK = "▁▂▃▄▅▆▇█";

function sparkline(values: number[], width = 44): string {
    if (values.length === 0) return "";
    // resample to `width` buckets so long traces still read as one curve
    const sampled: number[] = [];
    for (let i = 0; i < Math.min(width, values.length); i++) {
        sampled.push(values[Math.floor((i * values.length) / Math.min(width, values.length))]);
    }
    const min = Math.min(...sampled);
    const max = Math.max(...sampled);
    const span = max - min || 1;
    return sampled.map((v) => SPARK[Math.min(7, Math.floor(((v - min) / span) * 8))]).join("");
}

function analyzeSeries(series: Series) {
    if (series.kind === "discrete") {
        const { key, values } = series;
        return {
            kind: "discrete" as const,
            key,
            count: values.length,
            first: values[0]?.v,
            last: values[values.length - 1]?.v,
        };
    }
    const { key, points } = series;
    const vals = points.map((p) => p.val);
    const spanMs = points.length > 1 ? points[points.length - 1].t - points[0].t : 0;
    const gaps: number[] = [];
    for (let i = 1; i < points.length; i++) gaps.push(points[i].t - points[i - 1].t);
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)] ?? 0;
    const droppedGaps = medianGap > 0 ? gaps.filter((g) => g > medianGap * 2).length : 0;
    // spring fingerprint: how many times the curve crosses its settling value before the end
    const last = vals[vals.length - 1];
    let overshoots = 0;
    for (let i = 1; i < vals.length - 1; i++) {
        if ((vals[i - 1] - last) * (vals[i] - last) < 0) overshoots++;
    }
    const round = (v: number) => Math.round(v * 1000) / 1000;
    return {
        kind: "numeric" as const,
        key,
        count: points.length,
        spanMs,
        sampleHz: spanMs > 0 ? Math.round(((points.length - 1) / spanMs) * 1000) : 0,
        first: round(vals[0]),
        last: round(last),
        min: round(Math.min(...vals)),
        max: round(Math.max(...vals)),
        medianGapMs: round(medianGap),
        droppedGaps,
        overshoots,
        spark: sparkline(vals),
    };
}

function paintCadence(gaps: number[]): string {
    if (!gaps || gaps.length < 2) return "";
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    return ` (paint gap median ${median.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms)`;
}
