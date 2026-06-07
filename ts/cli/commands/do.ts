// `rngpui do …` — drive the live instance with synthetic input. Requires a launched
// host (we must own the service stdin to inject commands); an attached read-only
// target cannot be driven.

import type { AttachedHost, DumpNode, LaunchedHost } from "../host";
import { sleep } from "../../scripts/conformance-utils.mjs";
import { centerOf, parsePoint, resolve } from "../selectors";

type Host = LaunchedHost | AttachedHost;

function shortId(node: DumpNode): string {
    const a = node.accessibility ?? {};
    return a.testID ?? a.identifier ?? a.nativeID ?? a.label ?? (node.text ? `"${node.text.slice(0, 24)}"` : `#${node.globalId}`);
}

export async function runDo(host: Host, sub: string, args: string[], json: boolean): Promise<number> {
    if (host.mode !== "launch") {
        console.error("  do commands need a driveable target — launch one with --launch <entry.tsx>");
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
            launched.send({ $cmd: "tap", x, y });
            await sleep(150);
            if (json) console.log(JSON.stringify({ tapped: label, x, y }));
            else console.log(`  tapped ${label} at ${x.toFixed(0)},${y.toFixed(0)}`);
            return 0;
        }

        case "type": {
            const text = args.join(" ");
            if (!text) {
                console.error("  usage: rngpui do type <text>");
                return 1;
            }
            launched.send({ $cmd: "type", text });
            await sleep(120);
            if (json) console.log(JSON.stringify({ typed: text }));
            else console.log(`  typed: ${JSON.stringify(text)}`);
            return 0;
        }

        case "key": {
            const key = args[0];
            if (!key) {
                console.error("  usage: rngpui do key <key>   (e.g. enter, backspace, space, a)");
                return 1;
            }
            launched.send({ $cmd: "key", key });
            await sleep(100);
            if (json) console.log(JSON.stringify({ key }));
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
            launched.send({ $cmd: "scrollAt", x, y, dx: d.x, dy: d.y });
            await sleep(120);
            if (json) console.log(JSON.stringify({ scrolled: { x, y, dx: d.x, dy: d.y } }));
            else console.log(`  scrolled at ${x.toFixed(0)},${y.toFixed(0)} by ${d.x},${d.y}`);
            return 0;
        }

        default:
            console.error(`  unknown do subcommand: ${sub}`);
            console.error("  available: tap, type, key, scroll");
            return 1;
    }
}
