// `rngpui do …` — drive the live instance with synthetic input. Requires a
// driveable launch/session target; an attached read-only target cannot be driven.

import type { AttachedHost, DumpNode, LaunchedHost } from "../host";
import { sleep } from "../../scripts/conformance-utils.mjs";
import { centerOf, parsePoint, resolve } from "../selectors";

type Host = LaunchedHost | AttachedHost;
type ControlResponse = { ok: boolean; error?: string; targetId?: number; focusedId?: number; activated?: boolean };

function shortId(node: DumpNode): string {
    const a = node.accessibility ?? {};
    return a.testID ?? a.identifier ?? a.nativeID ?? a.label ?? (node.text ? `"${node.text.slice(0, 24)}"` : `#${node.globalId}`);
}

export async function runDo(host: Host, sub: string, args: string[], json: boolean): Promise<number> {
    if (host.mode !== "launch") {
        console.error("  do commands need a driveable target — use --launch <entry.tsx>, --bundle <app.hbc>, or --session <dir>");
        console.error("  (an attached running process isn't ours to drive)");
        return 1;
    }
    const launched = host;

    switch (sub) {
        case "tap": {
            const selector = args[0];
            if (!selector) {
                console.error("  usage: rngpui do tap <selector|x,y>");
                return 1;
            }
            let x: number;
            let y: number;
            let label = selector;
            const pt = parsePoint(selector);
            if (pt) {
                ({ x, y } = pt);
            } else {
                const dump = await launched.dump();
                const { best } = resolve(dump, selector);
                if (!best) {
                    console.error(`  no node matched "${selector}"`);
                    return 1;
                }
                const center = centerOf(best.node);
                if (!center) {
                    console.error(`  node ${shortId(best.node)} #${best.node.globalId} has no bounds — not tappable`);
                    return 1;
                }
                ({ x, y } = center);
                label = `${shortId(best.node)} #${best.node.globalId}`;
            }
            const response = await launched.request<ControlResponse>({ $cmd: "tap", x, y });
            if (!response.ok) {
                console.error(`  tap failed: ${response.error || "no native target"}`);
                return 1;
            }
            await sleep(150);
            if (json) console.log(JSON.stringify({ tapped: label, x, y, targetId: response.targetId }));
            else console.log(`  tapped ${label} at ${x.toFixed(0)},${y.toFixed(0)}`);
            return 0;
        }

        case "type": {
            const text = args.join(" ");
            if (!text) {
                console.error("  usage: rngpui do type <text>");
                return 1;
            }
            const response = await launched.request<ControlResponse>({ $cmd: "type", text });
            if (!response.ok) {
                console.error(`  type failed: ${response.error || "no focused input"}`);
                return 1;
            }
            await sleep(120);
            if (json) console.log(JSON.stringify({ typed: text, focusedId: response.focusedId }));
            else console.log(`  typed: ${JSON.stringify(text)}`);
            return 0;
        }

        case "key": {
            const key = args[0];
            if (!key) {
                console.error("  usage: rngpui do key <key>   (e.g. enter, backspace, space, a)");
                return 1;
            }
            const response = await launched.request<ControlResponse>({ $cmd: "key", key });
            if (!response.ok) {
                console.error(`  key failed: ${response.error || "no focused input"}`);
                return 1;
            }
            await sleep(100);
            if (json) console.log(JSON.stringify({ key, focusedId: response.focusedId }));
            else console.log(`  key: ${key}`);
            return 0;
        }

        case "scroll": {
            const target = args[0];
            const delta = args[1];
            if (!target || !delta) {
                console.error("  usage: rngpui do scroll <selector|x,y> <dx,dy>");
                return 1;
            }
            const d = parsePoint(delta);
            if (!d) {
                console.error(`  invalid delta "${delta}" — expected dx,dy`);
                return 1;
            }
            let x: number;
            let y: number;
            const pt = parsePoint(target);
            if (pt) {
                ({ x, y } = pt);
            } else {
                const dump = await launched.dump();
                const { best } = resolve(dump, target);
                const center = best ? centerOf(best.node) : null;
                if (!center) {
                    console.error(`  no scrollable node matched "${target}"`);
                    return 1;
                }
                ({ x, y } = center);
            }
            const response = await launched.request<ControlResponse>({ $cmd: "scrollAt", x, y, dx: d.x, dy: d.y });
            if (!response.ok) {
                console.error(`  scroll failed: ${response.error || "no scroll container"}`);
                return 1;
            }
            await sleep(120);
            if (json) console.log(JSON.stringify({ scrolled: { x, y, dx: d.x, dy: d.y, targetId: response.targetId } }));
            else console.log(`  scrolled at ${x.toFixed(0)},${y.toFixed(0)} by ${d.x},${d.y}`);
            return 0;
        }

        case "drag": {
            const from = args[0];
            const to = args[1];
            const steps = Math.max(2, Math.min(120, Number(args[2] ?? 24) || 24));
            if (!from || !to) {
                console.error("  usage: rngpui do drag <selector|x,y> <selector|x,y> [steps]");
                return 1;
            }
            const start = await resolveDrivePoint(launched, from);
            const end = await resolveDrivePoint(launched, to);
            if (!start || !end) return 1;
            const startResponse = await launched.request<ControlResponse>({
                $cmd: "dragAt",
                phase: "start",
                x: start.x,
                y: start.y,
            });
            if (!startResponse.ok) {
                console.error(`  drag start failed: ${startResponse.error || "no native target"}`);
                return 1;
            }
            let lastTargetId = startResponse.targetId;
            let activations = 0;
            for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                const x = start.x + (end.x - start.x) * t;
                const y = start.y + (end.y - start.y) * t;
                const response = await launched.request<ControlResponse>({ $cmd: "dragAt", phase: "move", x, y });
                if (!response.ok) {
                    await launched.request<ControlResponse>({ $cmd: "dragAt", phase: "end", x, y });
                    console.error(`  drag move failed: ${response.error || "no native target"}`);
                    return 1;
                }
                if (response.targetId !== lastTargetId && response.activated) activations += 1;
                lastTargetId = response.targetId;
                await sleep(16);
            }
            await launched.request<ControlResponse>({ $cmd: "dragAt", phase: "end", x: end.x, y: end.y });
            await sleep(150);
            if (json) console.log(JSON.stringify({ dragged: { from: start, to: end, steps, activations } }));
            else console.log(`  dragged ${steps} steps from ${start.x.toFixed(0)},${start.y.toFixed(0)} to ${end.x.toFixed(0)},${end.y.toFixed(0)}`);
            return 0;
        }

        default:
            console.error(`  unknown do subcommand: ${sub}`);
            console.error("  available: tap, type, key, scroll, drag");
            return 1;
    }
}

async function resolveDrivePoint(launched: LaunchedHost, selector: string): Promise<{ x: number; y: number } | null> {
    const pt = parsePoint(selector);
    if (pt) return pt;
    const dump = await launched.dump();
    const { best } = resolve(dump, selector);
    const center = best ? centerOf(best.node) : null;
    if (!center) {
        console.error(`  no node matched "${selector}"`);
        return null;
    }
    return center;
}
