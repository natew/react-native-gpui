#!/usr/bin/env bun
// `rngpui` — the react-native-gpui developer CLI. A get/do devtool over a running OR
// launched offscreen rngpui app, modeled on soot's sootsim CLI.
//
//   rngpui get describe composer:input --launch examples/superconductor.tsx
//   rngpui get color 200,300 --attach
//   rngpui do tap "Run" --launch examples/kitchen-sink.tsx
//
// GET commands introspect (tree / stats / webviews / describe / layout / style / color / point); DO
// commands drive (tap / type / key / scroll / drag). Selectors substring-match testID /
// identifier / nativeID / label / text / type, or `#<globalId>`, or `x,y`. `--json`
// for machine output.

import { attachHost, attachSession, closeSession, launchHost, type AttachedHost, type LaunchedHost } from "./host";
import { runGet } from "./commands/get";
import { runDo } from "./commands/do";
import { runFlow } from "./commands/flow";
import { runTrace } from "./commands/trace";
import { runDiff, runShot, type ShotFlags } from "./commands/shot";
import { runWatchReload } from "./watchReload";
import { runHotReload } from "./hotReload";

const HELP = `rngpui — react-native-gpui developer CLI

usage:
  rngpui shot <--bundle app.hbc | --launch entry.tsx | --session dir> [--size WxH] [--appearance light|dark] [--select id ...] [--out png] [--fixture] [--keep]
  rngpui reshot --session <dir> [--select id ...] [--out png]      sub-second re-capture of a kept session
  rngpui dev <--bundle app.hbc | --launch entry.tsx> [--size --appearance --fixture]   keep one offscreen instance alive; prints its session dir
  rngpui hot-reload --socket <control.sock> --build <cmd> --bundle <bundle.js> --root <dir> [--pid <pid-file>]   Fast Refresh on edit; SIGUSR2 fallback
  rngpui watch-reload --pid <pid-file> --root <dir> [--root <dir> ...]   send SIGUSR2 reload on source edits
  rngpui diff <before.png> <after.png> [--out highlight.png] [--threshold n]
  rngpui <get|do> <subcommand> [selector] [--launch <entry.tsx> | --bundle <app.hbc> | --session <dir> | --attach] [--json]
  rngpui trace <selector ...|--all> [--keys k1,k2] [--ms n] [--action "tap <sel>"] [target] [--json]
  rngpui flow [--profile] tap <selector> [tap <selector> ...] [--out <dir>] [target]
  rngpui close --session <dir>

the fast loop (offscreen, no screenshots, one command):
  shot                   launch → wait for a stable frame → write png + tree → print
                         the png path + bounds/color of every --select'd node. ONE call.
  dev                    launch once and keep it alive; print the session dir. Pair with
                         reshot for sub-second re-captures (no relaunch, no re-bundle).
  reshot                 re-capture a kept --session instantly (state/data changed → look again).
  diff                   compare two pngs: changed-pixel ratio + changed-region box (+ --out highlight).

shot/dev flags:
  --appearance light|dark  force the app theme (RNGPUI_FORCE_APPEARANCE) — no system toggle
  --select <selector>      measure this node (repeatable): prints bounds + sampled color
  --crop <x,y,w,h>         (reserved) region of interest
  --fixture                load deterministic demo data (AGENTBUS_FIXTURE_ONLY=1) — the
                           agentbus app paints an empty shell without a daemon or fixture
  --out <png>              where to write the capture (default /tmp/rngpui-shot.png)

target (pick one; defaults to --attach):
  --launch <entry.tsx>   compile the entry to Hermes bytecode, then spawn rngpui-service
  --bundle <app.hbc>     spawn rngpui-service against an existing Hermes bundle
  --keep                 keep the launched service alive and print its session dir
  --session <dir>        reuse a kept driveable session for do-then-get workflows
  --attach               attach to a running rngpui window; driveable only when
                         owner metadata advertises RNGPUI_CONTROL_SOCKET
  --size <WxH>           launched window size (default 1280x860)

get (introspect — read-only):
  get screen                     actionable visible-screen summary
  get tree                       full annotated node tree (bounds + ids)
  get stats [selector]           aggregate node counts, visibility, duplicate IDs,
                                 type/list-group counts, and webview totals
  get webviews                   webview inventory: source, bounds, visibility
  get describe [selector]        path, ids, computed bounds, resolved style, AND
                                 sampled dominant/average color within the bounds
  get layout [selector]          computed window-coordinate bounds per node
  get style <selector>           resolved style facts (incl. background/border/color)
  get color <selector|x,y>       sampled dominant/average color in a node or at a point
  get point <x,y>                topmost node + pixel color at a window point
  get frames                     painted-frame counter + live fps + frame-gap stats

trace (animation forensics — no screenshots):
  trace <selector ...>           record every animated style write (off-thread
                                 reanimated / tamagui driver) and NativeLayout tween
                                 tick under the matched subtrees, then report per-key
                                 curves: sparkline, endpoints, min/max, sample cadence,
                                 dropped-frame gaps, spring overshoot count.
  --all                          trace every node instead of a subtree
  --keys opacity,transform       only record these style keys
  --ms <n>                       observation window after actions fire (default 1200)
  --action "tap <sel>"           fire input after arming (repeatable; tap/key/type)
  example: rngpui trace dialog --action "tap open-settings" --ms 1500 --session <dir>

do (drive):
  do tap <selector|x,y>          synthesize a press at the node center / point
  do type <text>                 type into the focused input
  do key <key>                   send one key (enter, backspace, space, a, …)
  do scroll <selector|x,y> <dx,dy>  scroll the container at the point by a delta
  do drag <from> <to> [steps]    synthesize an owned offscreen press-drag

flow:
  flow --profile tap "Session A" tap "Session B"
                                 run semantic taps and write trees/screenshots
                                 plus profile.json (default /tmp/rngpui-flow-*)
  --no-screenshots               keep profile timing clean for rapid stress flows
  --settle-ms <n>                wait up to n ms for first tree change per step
                                 (default 700; use 0 for rapid fire)
  --cadence-ms <n>               fixed delay after each tap before the next step

selectors:
  #42            globalId 42
  composer       substring match on testID/identifier/nativeID/label/text/type
  200,300        literal window-coordinate point

examples:
  rngpui shot --bundle native-shell/.gpui-hermes/app.hbc --size 1360x880 --fixture --appearance dark --select stage --select trees-rail
  rngpui dev --bundle native-shell/.gpui-hermes/app.hbc --fixture        # → prints session dir
  rngpui reshot --session /var/.../rngpui-cli-XXXX --select composer
  rngpui diff /tmp/before.png /tmp/rngpui-shot.png --out /tmp/diff.png
  rngpui get describe stage --launch examples/superconductor.tsx
  rngpui get tree --launch examples/kitchen-sink.tsx --keep
  rngpui do tap count-button --session /tmp/rngpui-cli-abc123
  rngpui get describe --attach
  rngpui close --session /tmp/rngpui-cli-abc123
`;

function parseArgs(argv: string[]) {
    const args = argv.slice(2);
    const flags: Record<string, string | boolean> = {};
    const select: string[] = [];
    const actions: string[] = [];
    const roots: string[] = [];
    const ignores: string[] = [];
    const extensions: string[] = [];
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--json") flags.json = true;
        else if (a === "--attach") flags.attach = true;
        else if (a === "--launch") flags.launch = args[++i] ?? "";
        else if (a === "--bundle") flags.bundle = args[++i] ?? "";
        else if (a === "--session") flags.session = args[++i] ?? "";
        else if (a === "--keep") flags.keep = true;
        else if (a === "--size") flags.size = args[++i] ?? "";
        else if (a === "--appearance") flags.appearance = args[++i] ?? "";
        else if (a === "--select") select.push(args[++i] ?? "");
        else if (a === "--crop") flags.crop = args[++i] ?? "";
        else if (a === "--fixture") flags.fixture = true;
        else if (a === "--threshold") flags.threshold = args[++i] ?? "";
        else if (a === "--profile") flags.profile = true;
        else if (a === "--screenshots") flags.screenshots = true;
        else if (a === "--no-screenshots") flags.screenshots = false;
        else if (a === "--settle-ms") flags.settleMs = args[++i] ?? "";
        else if (a === "--cadence-ms") flags.cadenceMs = args[++i] ?? "";
        else if (a === "--keys") flags.keys = args[++i] ?? "";
        else if (a === "--ms") flags.ms = args[++i] ?? "";
        else if (a === "--action") actions.push(args[++i] ?? "");
        else if (a === "--all") flags.all = true;
        else if (a === "--out") flags.out = args[++i] ?? "";
        else if (a === "--pid") flags.pid = args[++i] ?? "";
        else if (a === "--socket") flags.socket = args[++i] ?? "";
        else if (a === "--build") flags.build = args[++i] ?? "";
        else if (a === "--root") roots.push(args[++i] ?? "");
        else if (a === "--ignore") ignores.push(args[++i] ?? "");
        else if (a === "--ext") extensions.push(args[++i] ?? "");
        else if (a === "--debounce-ms") flags.debounceMs = args[++i] ?? "";
        else if (a === "--label") flags.label = args[++i] ?? "";
        else if (a === "--once") flags.once = true;
        else if (a === "-h" || a === "--help") flags.help = true;
        else positional.push(a);
    }
    return { flags, positional, select, actions, roots, ignores, extensions };
}

function shotFlags(flags: Record<string, string | boolean>, select: string[]): ShotFlags {
    return {
        json: flags.json === true,
        size: flags.size ? String(flags.size) : undefined,
        appearance: flags.appearance ? String(flags.appearance) : undefined,
        out: flags.out ? String(flags.out) : undefined,
        select: select.filter(Boolean),
        crop: flags.crop ? String(flags.crop) : undefined,
        fixture: flags.fixture === true,
        session: flags.session ? String(flags.session) : process.env.RNGPUI_SESSION || undefined,
        bundle: flags.bundle !== undefined ? String(flags.bundle) : undefined,
        launch: flags.launch !== undefined ? String(flags.launch) : undefined,
        keep: flags.keep === true,
    };
}

async function main(): Promise<number> {
    const { flags, positional, select, actions, roots, ignores, extensions } = parseArgs(process.argv);
    if (flags.help || positional.length === 0) {
        console.log(HELP);
        return positional.length === 0 ? 1 : 0;
    }

    const [group, sub, ...rest] = positional;
    const json = flags.json === true;

    // The fast iteration commands own their whole host lifecycle (launch/attach +
    // capture + close), so they short-circuit the generic get/do/flow plumbing.
    if (group === "shot") {
        return runShot(shotFlags(flags, select));
    }
    if (group === "reshot") {
        const sf = shotFlags(flags, select);
        if (!sf.session) {
            console.error("  reshot needs --session <dir> (the dir `rngpui dev` printed) or RNGPUI_SESSION");
            return 1;
        }
        return runShot(sf);
    }
    if (group === "dev") {
        // keep one offscreen instance alive; capture a first frame, then leave it for reshot.
        const code = await runShot({ ...shotFlags(flags, select), keep: true });
        return code;
    }
    if (group === "hot-reload") {
        return runHotReload({
            socketPath: flags.socket ? String(flags.socket) : undefined,
            pidPath: flags.pid ? String(flags.pid) : undefined,
            roots: roots.filter(Boolean),
            buildCommand: flags.build ? String(flags.build) : undefined,
            bundlePath: flags.bundle ? String(flags.bundle) : undefined,
            ignores: ignores.filter(Boolean),
            extensions: extensions.filter(Boolean),
            debounceMs: flags.debounceMs ? Number(flags.debounceMs) : undefined,
            label: flags.label ? String(flags.label) : undefined,
            once: flags.once === true,
        });
    }
    if (group === "watch-reload") {
        return runWatchReload({
            pidPath: flags.pid ? String(flags.pid) : undefined,
            roots: roots.filter(Boolean),
            ignores: ignores.filter(Boolean),
            extensions: extensions.filter(Boolean),
            debounceMs: flags.debounceMs ? Number(flags.debounceMs) : undefined,
            label: flags.label ? String(flags.label) : undefined,
        });
    }
    if (group === "diff") {
        return runDiff(positional.slice(1), {
            json,
            out: flags.out ? String(flags.out) : undefined,
            threshold: flags.threshold ? Number(flags.threshold) : undefined,
        });
    }

    if (group === "close") {
        const session = flags.session || process.env.RNGPUI_SESSION;
        if (!session) {
            console.error("  close needs --session <dir> or RNGPUI_SESSION");
            return 1;
        }
        closeSession(String(session));
        if (!json) console.log(`  closed ${session}`);
        else console.log(JSON.stringify({ closed: String(session) }));
        return 0;
    }

    if (group !== "get" && group !== "do" && group !== "flow" && group !== "trace") {
        console.error(`  unknown command group: ${group}`);
        console.error("  run `rngpui --help` for the surface.");
        return 1;
    }
    if (!sub && group !== "flow" && !(group === "trace" && flags.all === true)) {
        console.error(`  ${group} needs a ${group === "trace" ? "selector (or --all)" : "subcommand"} — run \`rngpui --help\``);
        return 1;
    }

    let host: LaunchedHost | AttachedHost | null = null;
    try {
        const session = flags.session || process.env.RNGPUI_SESSION;
        if (session) {
            host = await attachSession(String(session));
        } else if (flags.bundle !== undefined) {
            host = await launchHost("", {
                bundle: String(flags.bundle),
                keep: flags.keep === true,
                size: flags.size ? String(flags.size) : undefined,
            });
        } else if (flags.launch !== undefined) {
            host = await launchHost(String(flags.launch), {
                keep: flags.keep === true,
                size: flags.size ? String(flags.size) : undefined,
            });
        } else {
            // default + explicit --attach both land here
            host = await attachHost();
        }

        const code =
            group === "get"
                ? await runGet(host, sub, rest, json)
                : group === "do"
                  ? await runDo(host, sub, rest, json)
                  : group === "trace"
                    ? await runTrace(host, sub ? [sub, ...rest] : [], {
                          json,
                          keys: flags.keys ? String(flags.keys).split(",").map((k) => k.trim()).filter(Boolean) : undefined,
                          ms: flags.ms ? Number(flags.ms) : 1_200,
                          actions: actions.filter(Boolean),
                          all: flags.all === true,
                      })
                    : await runFlow(host, sub ? [sub, ...rest] : rest, {
                        json,
                        profile: flags.profile === true,
                        screenshots: flags.screenshots === undefined ? undefined : flags.screenshots === true,
                        settleMs: flags.settleMs === undefined ? undefined : Number(flags.settleMs),
                        cadenceMs: flags.cadenceMs === undefined ? undefined : Number(flags.cadenceMs),
                        out: flags.out ? String(flags.out) : undefined,
                    });
        if (flags.keep === true && host.mode === "launch") {
            console.error(`[rngpui] session ${host.sessionDir}`);
        }
        return code;
    } catch (err) {
        console.error(`  ${err instanceof Error ? err.message : String(err)}`);
        return 1;
    } finally {
        host?.close();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error(err instanceof Error ? err.stack : String(err));
        process.exit(1);
    });
