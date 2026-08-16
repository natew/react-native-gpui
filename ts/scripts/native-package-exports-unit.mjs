#!/usr/bin/env bun

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativePackageExportsPlugin } from "./native-package-exports-plugin.mjs";

const root = mkdtempSync(join(tmpdir(), "rngpui-native-exports-"));
const modules = join(root, "node_modules");
const ordinary = join(modules, "ordinary-package");
const executor = join(modules, "executor-package");
const conditional = join(modules, "conditional-package");
mkdirSync(ordinary, { recursive: true });
mkdirSync(join(executor, "realtime"), { recursive: true });
mkdirSync(conditional, { recursive: true });

writeFileSync(
    join(ordinary, "package.json"),
    JSON.stringify({
        name: "ordinary-package",
        type: "module",
        exports: { "./barrel": { import: "./barrel.js" } },
    }),
);
writeFileSync(join(ordinary, "barrel.js"), "export * from 'executor-package/realtime';\n");

writeFileSync(
    join(executor, "package.json"),
    JSON.stringify({
        name: "executor-package",
        type: "module",
        sideEffects: false,
        exports: { "./realtime": { import: "./realtime/index.js" } },
    }),
);
writeFileSync(
    join(executor, "realtime", "index.js"),
    [
        "export { ordinaryValue } from './value.js';",
        "export { sharedValue } from './shared.js';",
    ].join("\n"),
);
writeFileSync(
    join(executor, "realtime", "value.js"),
    [
        "import { sharedValue } from './shared.js';",
        "export const ordinaryValue = sharedValue + 1;",
    ].join("\n"),
);
writeFileSync(join(executor, "realtime", "shared.js"), "export const sharedValue = 41;\n");

writeFileSync(
    join(conditional, "package.json"),
    JSON.stringify({
        name: "conditional-package",
        type: "module",
        exports: {
            ".": {
                browser: { import: "./web.js" },
                "react-native": { import: "./native.js" },
                import: "./web.js",
            },
        },
    }),
);
writeFileSync(join(conditional, "native.js"), "export const platformValue = 'native';\n");
writeFileSync(join(conditional, "web.js"), "export const platformValue = 'web';\n");
writeFileSync(join(root, "alias.js"), "export const aliasValue = 'alias';\n");
writeFileSync(
    join(root, "entry.js"),
    [
        "import { ordinaryValue } from 'ordinary-package/barrel';",
        "import { platformValue } from 'conditional-package';",
        "import { aliasValue } from 'virtual-alias';",
        "globalThis.__rngpuiNativeExportsResult = `${ordinaryValue}:${platformValue}:${aliasValue}`;",
    ].join("\n"),
);

try {
    const aliasPath = join(root, "alias.js");
    const result = await Bun.build({
        entrypoints: [join(root, "entry.js")],
        target: "browser",
        format: "iife",
        conditions: ["react-native"],
        plugins: [
            {
                name: "fixture alias",
                setup(build) {
                    build.onResolve({ filter: /^virtual-alias$/ }, () => ({ path: aliasPath }));
                },
            },
            nativePackageExportsPlugin({ root }),
        ],
        throw: false,
    });

    assert.equal(result.success, true, result.logs.map(String).join("\n"));
    const code = await result.outputs[0].text();
    globalThis.__rngpuiNativeExportsResult = undefined;
    new Function(code)();
    assert.equal(globalThis.__rngpuiNativeExportsResult, "42:native:alias");
    console.log("NATIVE_PACKAGE_EXPORTS_UNIT_PASS ordinary-export-star=native-condition=prior-alias");
} finally {
    delete globalThis.__rngpuiNativeExportsResult;
    rmSync(root, { recursive: true, force: true });
}
