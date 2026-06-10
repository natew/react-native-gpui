// Bun-build plugin: wire real react-native-reanimated@4 + react-native-worklets +
// @tamagui/animations-reanimated for the embedded Hermes target.
//
// HOW IT WORKS (the winning approach — see scripts/prebuild-reanimated.mjs):
// reanimated's `lib/module` re-export-barrel graph trips Bun's bundler into a
// tree-shake-then-dangle bug (`import_xN is not defined` at eval). ESBUILD bundles the
// same graph correctly. So we PRE-BUNDLE reanimated (and @tamagui/animations-reanimated)
// into self-contained ESM chunks with esbuild (worklets babel transform + native-seam
// redirect baked in), keeping `react` / `react-native-worklets` / `react-native-gpui`
// external. This plugin then simply ALIASES:
//   react-native-reanimated      → .reanimated-prebuilt/react-native-reanimated.mjs
//   @tamagui/animations-reanimated → .reanimated-prebuilt/tamagui-animations-reanimated.mjs
//   react-native-worklets        → ts/src/reanimated/worklets.ts (single-runtime stub,
//                                   which force-imports the seam → installs the globals)
// Bun then just includes those single files — no deep tree-shake of reanimated's graph.
//
// gpui runs ONE Hermes runtime: worklets execute as ordinary inline closures, runOnUI =
// queueMicrotask, runOnJS = identity, and `global._updateProps` is the off-thread fast
// path (→ `__rngpui_setNodeStyle` → Rust animated-style overlay → cx.notify without a
// React re-commit). The prebuilt chunks contain the real reanimated + Tamagui driver;
// the seam + worklets stub (this repo) provide the thin native seam.
//
// Run `bun scripts/prebuild-reanimated.mjs` whenever react-native-reanimated or
// @tamagui/animations-reanimated changes (or on postinstall). If the prebuilt chunk is
// missing, this plugin throws with that instruction.
//
// Usage:
//   import { reanimatedBunPlugin } from '<rng>/ts/scripts/reanimated-bun-plugin.mjs'
//   plugins: [reanimatedBunPlugin({ rngTsRoot })]
//     rngTsRoot      — absolute path to react-native-gpui/ts (seam/worklets/prebuilt live here)
//     prebuiltDir    — override the prebuilt chunk dir (default: <rngTsRoot>/.reanimated-prebuilt)

import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

// worklet keywords — gate the babel transform so we only pay for files that use them.
const WORKLET_KEYWORDS =
  /worklet|useAnimatedStyle|useAnimatedProps|useDerivedValue|useAnimatedReaction|useAnimatedGestureHandler|useAnimatedScrollHandler|useFrameCallback|useWorkletCallback|withTiming|withSpring|withDecay|withDelay|withRepeat|runOnUI|createAnimatedPropAdapter/

export function reanimatedBunPlugin(opts = {}) {
  const rngTsRoot = opts.rngTsRoot
  if (!rngTsRoot) throw new Error('reanimatedBunPlugin: rngTsRoot is required')
  const resolveRoot = opts.resolveRoot || rngTsRoot
  const workletsPath = resolve(rngTsRoot, 'src/reanimated/worklets.ts')
  const seamPath = resolve(rngTsRoot, 'src/reanimated/seam.ts')
  const reanimatedHostPath = resolve(rngTsRoot, 'src/reanimated/reanimated-host.ts')
  const prebuiltDir = opts.prebuiltDir || resolve(rngTsRoot, '.reanimated-prebuilt')
  const reanimatedChunk = resolve(prebuiltDir, 'react-native-reanimated.mjs')
  const tamaguiReanimatedChunk = resolve(prebuiltDir, 'tamagui-animations-reanimated.mjs')
  // the prebuilt chunks emit external `import { View } from "react-native"`; resolve
  // `react-native` → the gpui RN-compatible index. When the host bundler already aliases
  // it (the gui app does), pass aliasReactNative:false.
  const reactNativeIndex = opts.reactNativeIndex || resolve(rngTsRoot, 'src/index.ts')
  const aliasReactNative = opts.aliasReactNative !== false

  // babel worklets transform — applied to APP + Tamagui-driver source (NOT the prebuilt
  // reanimated chunk, which already ran it, and NOT reanimated node_modules). This is
  // REQUIRED: `useAnimatedStyle`/`useDerivedValue` read `updater.__closure` to extract
  // the SharedValues a worklet depends on (its mapper inputs); without the babel lift
  // the closure is empty, the mapper subscribes to nothing, a `sv.value = …` write never
  // re-runs the mapper, and a Tamagui spring never advances (snaps to its target). The
  // lifted function still runs with LEXICAL scope on the single runtime (the
  // `this.__closure` form lives only in `__initData.code`, used for cross-runtime
  // serialization we never do), so the per-frame `frame()` rAF loop keeps working.
  const pluginRequire = createRequire(resolve(resolveRoot, 'package.json'))
  let babel = null
  let workletsPluginPath = null
  let jsxSyntax = null
  let presetTs = null
  const loadBabel = () => {
    if (babel) return
    babel = pluginRequire('@babel/core')
    workletsPluginPath = pluginRequire.resolve('react-native-worklets/plugin')
    jsxSyntax = pluginRequire.resolve('@babel/plugin-syntax-jsx')
    presetTs = pluginRequire.resolve('@babel/preset-typescript')
  }

  return {
    name: 'reanimated prebuilt chunks + worklets seam',
    setup(build) {
      if (aliasReactNative) {
        build.onResolve({ filter: /^react-native$/ }, () => ({ path: reactNativeIndex }))
      }
      // react-native-worklets (bare + any subpath) → single-runtime stub. The stub
      // force-imports the seam, which installs reanimated's globals
      // (__reanimatedModuleProxy, global._updateProps, __RUNTIME_KIND=2, RN$Bridgeless)
      // before the reanimated chunk evaluates.
      build.onResolve({ filter: /^react-native-worklets(\/.*)?$/ }, () => ({ path: workletsPath }))

      // react-native-reanimated → the rngpui host wrapper (stamps the animation
      // factories for the off-thread worklet runtime — see reanimated-host.ts),
      // which itself imports the esbuild-prebuilt chunk via the virtual id below.
      build.onResolve({ filter: /^react-native-reanimated$/ }, () => {
        if (!existsSync(reanimatedChunk)) {
          throw new Error(
            `[reanimated] prebuilt chunk missing: ${reanimatedChunk}\n` +
              `  run: bun scripts/prebuild-reanimated.mjs`,
          )
        }
        return { path: reanimatedHostPath }
      })
      build.onResolve({ filter: /^rngpui-reanimated-prebuilt$/ }, () => ({ path: reanimatedChunk }))

      // @tamagui/animations-reanimated → the esbuild-prebuilt chunk (when present).
      build.onResolve({ filter: /^@tamagui\/animations-reanimated$/ }, () => {
        if (existsSync(tamaguiReanimatedChunk)) return { path: tamaguiReanimatedChunk }
        // not prebuilt (e.g. a bundle that doesn't use the Tamagui reanimated driver) —
        // let it resolve normally; if the app actually imports it, that surfaces a clear
        // resolve error pointing at the missing chunk.
        return undefined
      })

      // worklet transform on APP + Tamagui-driver source (see the comment above).
      build.onLoad({ filter: /\.(tsx?|jsx?|mjs)$/ }, async (args) => {
        // skip: the prebuilt chunks (already transformed), the seam/worklets stub, and
        // anything inside reanimated/worklets node_modules (the prebuild owns those).
        if (
          args.path.startsWith(prebuiltDir) ||
          args.path === seamPath ||
          args.path === workletsPath ||
          /node_modules\/(react-native-reanimated|react-native-worklets)\//.test(args.path)
        ) {
          return undefined
        }
        const source = await Bun.file(args.path).text()
        if (!WORKLET_KEYWORDS.test(source)) return undefined
        loadBabel()
        const isTsx = args.path.endsWith('.tsx')
        const isTs = /\.(tsx?|mts|cts)$/.test(args.path)
        const result = await babel.transformAsync(source, {
          filename: args.path,
          babelrc: false,
          configFile: false,
          sourceMaps: false,
          presets: isTs
            ? [[presetTs, { isTSX: isTsx, allExtensions: isTsx, allowDeclareFields: true }]]
            : [],
          plugins: [[jsxSyntax], [workletsPluginPath, { processNestedWorklets: true }]],
        })
        if (!result?.code) return undefined
        return { contents: result.code, loader: isTsx || args.path.endsWith('.jsx') ? 'jsx' : 'js' }
      })
    },
  }
}
