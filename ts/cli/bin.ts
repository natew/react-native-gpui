#!/usr/bin/env node
// `rngpui` — the react-native-gpui developer CLI. A get/do devtool over a running OR
// launched offscreen rngpui app, modeled on soot's sootsim CLI.
//
//   rngpui get describe composer:input --launch examples/superconductor.tsx
//   rngpui get color 200,300 --attach
//   rngpui do tap "Run" --launch examples/kitchen-sink.tsx
//
// GET commands introspect (tree / describe / layout / style / color / point); DO
// commands drive (tap / type / key / scroll). Selectors substring-match testID /
// identifier / nativeID / label / text / type, or `#<globalId>`, or `x,y`. `--json`
// for machine output.

import { attachHost, launchHost, type AttachedHost, type LaunchedHost } from "./host";
import { runGet } from "./commands/get";
import { runDo } from "./commands/do";

const HELP = `rngpui — react-native-gpui developer CLI

usage:
  rngpui <get|do> <subcommand> [selector] [--launch <entry.tsx> | --attach] [--json]

target (pick one; defaults to --attach):
  --launch <entry.tsx>   spawn the entry offscreen + non-activating, drive + dump it
  --attach               capture/describe the running rngpui window read-only
  --size <WxH>           launched window size (default 1280x860)

get (introspect — read-only):
  get tree                       full annotated node tree (bounds + ids)
  get describe [selector]        path, ids, computed bounds, resolved style, AND
                                 sampled dominant/average color within the bounds
  get layout [selector]          computed window-coordinate bounds per node
  get style <selector>           resolved style facts (incl. background/border/color)
  get color <selector|x,y>       sampled dominant/average color in a node or at a point
  get point <x,y>                topmost node + pixel color at a window point

do (drive — needs --launch):
  do tap <selector|x,y>          synthesize a press at the node center / point
  do type <text>                 type into the focused input
  do key <key>                   send one key (enter, backspace, space, a, …)
  do scroll <selector|x,y> <dx,dy>  scroll the container at the point by a delta

selectors:
  #42            globalId 42
  composer       substring match on testID/identifier/nativeID/label/text/type
  200,300        literal window-coordinate point

examples:
  rngpui get describe stage --launch examples/superconductor.tsx
  rngpui do tap left-session:s2 --launch native-shell/app.tsx
  rngpui get color 640,400 --attach --json
`;

function parseArgs(argv: string[]) {
    const args = argv.slice(2);
    const flags: Record<string, string | boolean> = {};
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--json") flags.json = true;
        else if (a === "--attach") flags.attach = true;
        else if (a === "--launch") flags.launch = args[++i] ?? "";
        else if (a === "--launch-cmd") flags.launchCmd = args[++i] ?? "";
        else if (a === "--cwd") flags.cwd = args[++i] ?? "";
        else if (a === "--size") flags.size = args[++i] ?? "";
        else if (a === "-h" || a === "--help") flags.help = true;
        else positional.push(a);
    }
    return { flags, positional };
}

async function main(): Promise<number> {
    const { flags, positional } = parseArgs(process.argv);
    if (flags.help || positional.length === 0) {
        console.log(HELP);
        return positional.length === 0 ? 1 : 0;
    }

    const [group, sub, ...rest] = positional;
    const json = flags.json === true;

    if (group !== "get" && group !== "do") {
        console.error(`  unknown command group: ${group}`);
        console.error("  run `rngpui --help` for the surface.");
        return 1;
    }
    if (!sub) {
        console.error(`  ${group} needs a subcommand — run \`rngpui --help\``);
        return 1;
    }

    let host: LaunchedHost | AttachedHost | null = null;
    try {
        if (flags.launchCmd !== undefined) {
            host = await launchHost("", {
                launchCmd: String(flags.launchCmd),
                cwd: flags.cwd ? String(flags.cwd) : undefined,
                size: flags.size ? String(flags.size) : undefined,
            });
        } else if (flags.launch !== undefined) {
            host = await launchHost(String(flags.launch), { size: flags.size ? String(flags.size) : undefined });
        } else {
            // default + explicit --attach both land here
            host = await attachHost();
        }

        if (group === "get") return await runGet(host, sub, rest, json);
        return await runDo(host, sub, rest, json);
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
