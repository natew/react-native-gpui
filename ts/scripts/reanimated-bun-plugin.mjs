// Shared Bun-build plugin: wires real react-native-reanimated@4 + react-native-worklets
// for the embedded Hermes target.
//
// Jobs:
//   1. NATIVE-SEAM REDIRECT — react-native-worklets → our single-runtime stub
//      (ts/src/reanimated/worklets.ts, which force-imports ts/src/reanimated/seam.ts);
//      reanimated's platformFunctions → the seam's named exports. The seam installs the
//      globals (`__reanimatedModuleProxy`, `global._updateProps`, `__RUNTIME_KIND=2`,
//      `RN$Bridgeless`) reanimated reads, and `global._updateProps` is the off-thread
//      fast path (→ `__rngpui_setNodeStyle` → Rust animated-style overlay).
//   2. RN-INTERNAL SHIMS — `react-native` → the gpui RN-compatible index, plus tiny
//      shims for the RN internals reanimated reaches (processColor, TurboModuleRegistry,
//      ReactFabric, …) so the bundle stays self-contained.
//   3. WORKLET TRANSFORM — OPT-IN (RNGPUI_WORKLET_TRANSFORM=1). gpui runs ONE Hermes
//      runtime, so worklets execute as ordinary inline closures (lexical capture works);
//      the babel `__initData`/`__closure` lift is only for cross-runtime serialization,
//      which we never do. Off by default because under Bun's bundler the worklet plugin
//      reshapes reanimated's internal exports in a way Bun can't namespace.
//
// KNOWN LIMITATION (full reanimated): Bun's bundler tree-shakes modules reached only
// through reanimated's re-export barrels / pure default imports but leaves their
// namespace refs dangling at eval (`import_xN is not defined`). The barrel-rewrite +
// side-effect-pin + per-subtree stubs below fix many of these, but reanimated's deep
// `lib/module` graph (layoutReanimation builders, etc.) still surfaces new danglers,
// so FULL react-native-reanimated does not yet eval cleanly under Bun. The fast-path
// MECHANISM this repo owns (seam + overlay) is validated directly by
// examples/anim-overlay-conformance.tsx, which imports only the seam. Finishing full
// reanimated needs either a non-Bun bundler (Metro/rollup like soot's vite path) or the
// remaining per-subtree stubs. See examples/reanimated-conformance.tsx (the end-to-end
// target) and the handoff.
//
// Usage (from a Bun.build plugins array):
//   import { reanimatedBunPlugin } from '<rng>/ts/scripts/reanimated-bun-plugin.mjs'
//   plugins: [reanimatedBunPlugin({ rngTsRoot, resolveRoot })]
//     rngTsRoot   — absolute path to react-native-gpui/ts (where seam.ts/worklets.ts live)
//     resolveRoot — dir to resolve react-native-worklets/plugin + @babel/core from
//                   (the project that has them installed; defaults to rngTsRoot)

import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'

const WORKLET_KEYWORDS = [
  'worklet',
  'useAnimatedStyle',
  'useAnimatedProps',
  'useDerivedValue',
  'useAnimatedReaction',
  'useAnimatedGestureHandler',
  'useAnimatedScrollHandler',
  'useFrameCallback',
  'useWorkletCallback',
  'withTiming',
  'withSpring',
  'withDecay',
  'withDelay',
  'withRepeat',
  'runOnUI',
  'createAnimatedPropAdapter',
  'executeOnUIRuntimeSync',
]
const WORKLET_REGEX = new RegExp(WORKLET_KEYWORDS.join('|'))
// don't transform react/react-dom/react-native themselves (false positives + cycles).
const IGNORED_PATHS = /node_modules\/(react|react-dom|react-native-web)\//

// upstream reanimated native-seam files (subpaths) → our seam export shape. These are
// the ONLY reanimated modules we replace; everything else resolves normally.
// We do NOT redirect `specs/NativeReanimatedModule` — it's
// `TurboModuleRegistry.get('ReanimatedModule')`, which our TurboModuleRegistry shim
// returns null for, so reanimated's `ReanimatedTurboModule` is falsy and its
// constructor falls through to reading the global `__reanimatedModuleProxy` our seam
// installs (the seam is force-imported by the worklets stub). Redirecting it instead
// orphaned the package's `specs/index` namespace (`import_NativeReanimatedModule is
// not defined`). Only the platform functions (which hit native on real iOS) redirect.
const REANIMATED_SEAM_SUBPATHS = [
  'platformFunctions/scrollTo',
  'platformFunctions/measure',
  'platformFunctions/setNativeProps',
  'platformFunctions/dispatchCommand',
  'platformFunctions/setGestureState',
]

// RN-internal subpaths reanimated/worklets import that the gpui `react-native` index
// doesn't re-export. We satisfy each with a tiny inline shim so the bundle stays
// self-contained — none of these touch real native modules on the gpui target.
const RN_INTERNAL_SHIMS = [
  {
    // processColor — RN's color → ARGB int. reanimated's worklet color interpolation
    // calls this; a faithful enough impl (named colors fall back to black) so animated
    // colors round-trip to the host as numbers the seam re-encodes to rgba().
    match: /react-native\/Libraries\/StyleSheet\/processColor(\.js)?$/,
    contents: `
      function processColor(color){
        if (color == null) return null;
        if (typeof color === 'number') return color >>> 0;
        if (typeof color !== 'string') return null;
        var s = color.trim();
        var m;
        if ((m = /^#([0-9a-f]{6})$/i.exec(s))) { return (0xff000000 | parseInt(m[1],16)) >>> 0; }
        if ((m = /^#([0-9a-f]{8})$/i.exec(s))) { var n=parseInt(m[1],16); var a=n&0xff; return (((a<<24)|(n>>>8))>>>0); }
        if ((m = /^#([0-9a-f]{3})$/i.exec(s))) { var h=m[1]; var r=parseInt(h[0]+h[0],16),g=parseInt(h[1]+h[1],16),b=parseInt(h[2]+h[2],16); return (0xff000000|(r<<16)|(g<<8)|b)>>>0; }
        if ((m = /^rgba?\\(([^)]+)\\)$/i.exec(s))) {
          var p = m[1].split(',').map(function(x){return x.trim()});
          var r=parseInt(p[0])||0, g=parseInt(p[1])||0, b=parseInt(p[2])||0;
          var a = p[3] === undefined ? 1 : parseFloat(p[3]); if (!(a>=0)) a=0; if (a>1) a=1;
          return ((((a*255)&0xff)<<24)|(r<<16)|(g<<8)|b)>>>0;
        }
        return 0xff000000>>>0;
      }
      export default processColor;
    `,
  },
  {
    match: /react-native\/Libraries\/StyleSheet\/normalizeColor(\.js)?$/,
    contents: `import processColor from 'react-native/Libraries/StyleSheet/processColor';\nexport default processColor;`,
  },
  {
    match: /react-native\/Libraries\/Components\/View\/ReactNativeStyleAttributes$/,
    contents: `export default {};`,
  },
  {
    // findHostInstance_DEPRECATED slow path — never hit (our Instances carry the
    // fast-path fields), but the lazy require must resolve. Throw if ever called.
    match: /react-native\/Libraries\/Renderer\/shims\/ReactFabric$/,
    contents: `export function findHostInstance_DEPRECATED(){ throw new Error('rngpui: findHostInstance_DEPRECATED unavailable'); }\nexport default { findHostInstance_DEPRECATED: findHostInstance_DEPRECATED };`,
  },
  {
    match: /react-native\/Libraries\/TurboModule\/TurboModuleRegistry$/,
    // gpui has no TurboModuleRegistry; `get` returns null so reanimated's
    // ReanimatedTurboModule is falsy (skips installTurboModule) and falls through to
    // reading our installed global.__reanimatedModuleProxy.
    contents: `export function get(){ return null; }\nexport function getEnforcing(){ return {}; }\nexport default { get: get, getEnforcing: getEnforcing };`,
  },
  {
    match: /react-native\/Libraries\/Core\/setUpXHR$/,
    contents: `export {};`,
  },
  {
    match: /react-native\/Libraries\/StyleSheet\/PlatformColorValueTypes(IOS)?(\.d\.ts)?$/,
    contents: `export function PlatformColor(){ return undefined; }\nexport function DynamicColorIOS(){ return undefined; }\nexport function normalizeColorObject(c){ return c; }\nexport function processColorObject(c){ return c; }\nexport default {};`,
  },
]

export function reanimatedBunPlugin(opts = {}) {
  const rngTsRoot = opts.rngTsRoot
  if (!rngTsRoot) throw new Error('reanimatedBunPlugin: rngTsRoot is required')
  const resolveRoot = opts.resolveRoot || rngTsRoot
  const seamPath = resolve(rngTsRoot, 'src/reanimated/seam.ts')
  const workletsPath = resolve(rngTsRoot, 'src/reanimated/worklets.ts')
  const colorsProcessorShim = resolve(rngTsRoot, 'src/reanimated/colors-processor-shim.ts')
  // `react-native` → the gpui RN-compatible index (View, Text, Platform, processColor,
  // findNodeHandle, …). When the host bundler already aliases react-native (the gui
  // app does), pass aliasReactNative:false so we don't double-resolve.
  const reactNativeIndex = opts.reactNativeIndex || resolve(rngTsRoot, 'src/index.ts')
  const aliasReactNative = opts.aliasReactNative !== false

  const pluginRequire = createRequire(resolve(resolveRoot, 'package.json'))
  const workletsPluginPath = pluginRequire.resolve('react-native-worklets/plugin')
  // We bundle reanimated's compiled `lib/module/` (plain ESM — no Flow/TS, so Bun
  // parses it cleanly), and fix Bun's `export {…} from` re-export tree-shake-then-
  // dangle bug with the barrel rewrite in onLoad below. The `src/` entry carries Flow
  // types Bun can't parse, so we do NOT force it.
  // lazily required so a build that never hits a worklet file doesn't load babel.
  let babel = null
  const getBabel = () => (babel ??= pluginRequire('@babel/core'))

  return {
    name: 'reanimated native seam + worklets transform',
    setup(build) {
      // ── react-native alias + RN-internal shims ───────────────────────────
      if (aliasReactNative) {
        build.onResolve({ filter: /^react-native$/ }, () => ({ path: reactNativeIndex }))
      }
      // RN-internal subpaths reanimated/worklets reach — satisfy each from a virtual
      // module so the bundle stays self-contained (none hit real native here).
      const RN_SHIM_NS = 'rngpui-rn-internal-shim'
      build.onResolve({ filter: /^react-native\/Libraries\// }, (args) => {
        const shim = RN_INTERNAL_SHIMS.find((entry) => entry.match.test(args.path))
        if (shim) return { path: args.path, namespace: RN_SHIM_NS }
        return undefined
      })
      build.onLoad({ filter: /.*/, namespace: RN_SHIM_NS }, (args) => {
        const shim = RN_INTERNAL_SHIMS.find((entry) => entry.match.test(args.path))
        return { contents: shim ? shim.contents : 'export default {};', loader: 'js' }
      })

      // reanimated's `common/style/processors` barrel re-exports `processColor*` from
      // `./colors`. Bun's bundler tree-shakes the colors module out of the esm output
      // but leaves `config.ts`'s `colorAttributes = { process: processColorN }` dangling
      // ("Property 'processColorN' doesn't exist" at eval). Replace the barrel with a
      // generated module that imports each REAL processor directly (DIRECT imports,
      // which Bun keeps) and the colors from our self-contained shim, re-exporting the
      // identical surface.
      const STYLE_PROCESSORS_NS = 'rngpui-reanimated-style-processors'
      build.onResolve({ filter: /(^|\/)processors$/ }, (args) => {
        if (!args.importer || !args.importer.includes('react-native-reanimated')) return undefined
        const abs = resolve(dirname(args.importer), args.path)
        if (!abs.includes('common/style/processors')) return undefined
        const dir = abs // .../common/style/processors
        return { path: dir, namespace: STYLE_PROCESSORS_NS }
      })
      build.onLoad({ filter: /.*/, namespace: STYLE_PROCESSORS_NS }, (args) => {
        const dir = args.path
        const c = JSON.stringify(colorsProcessorShim)
        const r = (name) => JSON.stringify(resolve(dir, name))
        return {
          contents: `
            export { DynamicColorIOS, PlatformColor, processColor, processColorNumber, processColorsInProps } from ${c};
            export { processFilter } from ${r('filter')};
            export { processFontWeight } from ${r('font')};
            export { processInset, processInsetBlock, processInsetInline } from ${r('insets')};
            export { processAspectRatio, processGap } from ${r('others')};
            export { processBoxShadow } from ${r('shadows')};
            export { processTransform } from ${r('transform')};
            export { processTransformOrigin } from ${r('transformOrigin')};
          `,
          loader: 'js',
          resolveDir: dir,
        }
      })

      // ── flatten the ReanimatedModule instance barrel ─────────────────────
      // `ReanimatedModule/index` re-exports `ReanimatedModule` from
      // `./reanimatedModuleInstance` (which builds it via createNativeReanimatedModule).
      // Bun mis-binds the double-hop barrel namespace (`import_reanimatedModuleInstanceN
      // is not defined`). Replace the index with a single-hop module that constructs
      // `ReanimatedModule` here from the real `./NativeReanimated`, exporting it directly.
      const REANIMATED_MODULE_NS = 'rngpui-reanimated-module-instance'
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!args.importer || !args.importer.includes('react-native-reanimated')) return undefined
        const abs = args.path.startsWith('.') ? resolve(dirname(args.importer), args.path) : args.path
        if (/[\\/]ReanimatedModule([\\/]index)?$/.test(abs) || /[\\/]ReanimatedModule[\\/]index\.js$/.test(abs)) {
          // resolve the sibling NativeReanimated module path for the stub to import.
          const dir = abs.replace(/[\\/]index(\.js)?$/, '').replace(/[\\/]ReanimatedModule$/, '/ReanimatedModule')
          return { path: dir, namespace: REANIMATED_MODULE_NS }
        }
        return undefined
      })
      build.onLoad({ filter: /.*/, namespace: REANIMATED_MODULE_NS }, (args) => {
        const dir = args.path // .../ReanimatedModule
        return {
          contents: `
            import { createNativeReanimatedModule } from ${JSON.stringify(resolve(dir, 'NativeReanimated'))};
            export const ReanimatedModule = createNativeReanimatedModule();
          `,
          loader: 'js',
          resolveDir: dir,
        }
      })

      // ── stub reanimated's native specs barrel ────────────────────────────
      // `specs/index.js` does `import ReanimatedTurboModule from './NativeReanimatedModule';
      // export { ReanimatedTurboModule }`, where the inner module is
      // `TurboModuleRegistry.get('ReanimatedModule')` — undefined on gpui. Bun drops the
      // inner module and leaves a dangling `import_NativeReanimatedModule`. Replace the
      // whole specs barrel with `ReanimatedTurboModule = null` (the value reanimated's
      // NativeReanimated constructor expects on a non-TurboModule platform → it falls
      // through to the global `__reanimatedModuleProxy` our seam installs).
      const SPECS_STUB_NS = 'rngpui-reanimated-specs-stub'
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!args.importer || !args.importer.includes('react-native-reanimated')) return undefined
        const abs = args.path.startsWith('.') ? resolve(dirname(args.importer), args.path) : args.path
        if (/\/specs(\/index)?$/.test(abs) || /\/specs\/index\.js$/.test(abs)) {
          return { path: 'reanimated-specs-stub', namespace: SPECS_STUB_NS }
        }
        return undefined
      })
      build.onLoad({ filter: /.*/, namespace: SPECS_STUB_NS }, () => ({
        contents: 'export const ReanimatedTurboModule = null;\nexport default null;',
        loader: 'js',
      }))

      // ── stub reanimated's web barrels (native files import these but only call them
      // in the dead SHOULD_BE_USE_WEB branch). Bundling the real web modules drags in
      // the web propsBuilder/ruleBuilder whose barrel refs dangle under Bun
      // (`import_createPropsBuilderN is not defined`). Replace the 3 web barrels native
      // code imports with stubs exporting exactly those names as no-ops. ────────────
      const WEB_BARREL_STUBS = {
        // `common/web` ← updateProps.js
        'common/web': `
          export function processBoxShadowWeb(v){ return v; }
          export function processFilterWeb(v){ return v; }
        `,
        // `layoutReanimation/web` ← createAnimatedComponent/AnimatedComponent.js
        'layoutReanimation/web': `
          export function configureWebLayoutAnimations(){}
          export function getReducedMotionFromConfig(){ return false; }
          export function saveSnapshot(){}
          export function startWebLayoutAnimation(){}
          export function tryActivateLayoutTransition(){ return false; }
        `,
        // `ReanimatedModule/js-reanimated/webUtils` ← js-reanimated/index.js
        'ReanimatedModule/js-reanimated/webUtils': `
          export function createReactDOMStyle(s){ return s; }
          export function createTextShadowValue(){ return undefined; }
          export function createTransformValue(){ return undefined; }
        `,
      }
      const WEB_BARREL_NS = 'rngpui-reanimated-web-barrel'
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!args.importer || !args.importer.includes('react-native-reanimated')) return undefined
        const abs = args.path.startsWith('.') ? resolve(dirname(args.importer), args.path) : args.path
        for (const key of Object.keys(WEB_BARREL_STUBS)) {
          if (abs.replace(/\.js$/, '').endsWith(`/${key}`) || abs.replace(/\.js$/, '').endsWith(`/${key}/index`)) {
            return { path: key, namespace: WEB_BARREL_NS }
          }
        }
        return undefined
      })
      build.onLoad({ filter: /.*/, namespace: WEB_BARREL_NS }, (args) => ({
        contents: WEB_BARREL_STUBS[args.path] ?? 'export default {};',
        loader: 'js',
      }))

      // ── stub reanimated's css/svg subtree ────────────────────────────────
      // Only `initializers.ts` imports `./css/svg` (initSvgCssSupport), and the SVG
      // processor barrels there trip Bun's tree-shake-then-dangle bug (`import_stroke is
      // not defined`). Tamagui's spring path (useAnimatedStyle/withSpring) never touches
      // SVG CSS animations, so stub the whole subtree to a no-op initializer.
      const SVG_STUB_NS = 'rngpui-reanimated-svg-stub'
      build.onResolve({ filter: /(^|\/)svg$/ }, (args) => {
        if (!args.importer || !args.importer.includes('react-native-reanimated')) return undefined
        const abs = resolve(dirname(args.importer), args.path)
        if (abs.includes('/css/svg')) return { path: 'reanimated-svg-stub', namespace: SVG_STUB_NS }
        return undefined
      })
      build.onLoad({ filter: /.*/, namespace: SVG_STUB_NS }, () => ({
        contents: 'export function initSvgCssSupport(){}\nexport default {};',
        loader: 'js',
      }))

      // ── seam redirects ───────────────────────────────────────────────────
      // react-native-worklets (bare + any subpath) → single-runtime stub.
      build.onResolve({ filter: /^react-native-worklets(\/.*)?$/ }, () => ({ path: workletsPath }))
      // reanimated platformFunctions (`scrollTo`/`measure`/`setNativeProps`/…) → seam.
      // Imports inside the package are relative (`./measure` from platformFunctions/
      // index, or `../platformFunctions/measure`), so match (importer inside
      // react-native-reanimated) AND (resolved into platformFunctions) AND (basename is
      // one we replace).
      const seamBasenames = REANIMATED_SEAM_SUBPATHS.map((sub) => sub.split('/').pop())
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!args.importer || !args.importer.includes('react-native-reanimated')) return undefined
        const base = args.path.split('/').pop()?.replace(/\.(t|j)sx?$/, '')
        if (!base || !seamBasenames.includes(base)) return undefined
        const inPlatformFns =
          args.path.includes('platformFunctions') || args.importer.includes('platformFunctions')
        if (inPlatformFns) return { path: seamPath }
        return undefined
      })

      // ── barrel re-export rewrite (general Bun fix) ───────────────────────
      // reanimated is full of re-export barrels (`export { A, B } from './x'`). Bun's
      // bundler tree-shakes the source module out but leaves the dangling binding
      // (`import_xN is not defined` / `Property 'processN' doesn't exist` at eval). The
      // `import ... ; export { ... }` form does NOT trigger this — Bun keeps the binding.
      // Rewrite every `export { … } from '…'` in reanimated source into that form. This
      // is purely structural (same exports), applied only to reanimated files.
      build.onLoad({ filter: /\.(tsx?|jsx?|mjs)$/ }, async (args) => {
        if (!args.path.includes('react-native-reanimated')) return undefined
        const src = await Bun.file(args.path).text()
        let auto = 0
        const sideEffectSources = new Set()
        let rewritten = src.replace(
          /export\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"][^'"]+['"])/g,
          (_m, typeKw, names, from) => {
            // skip `export type { … } from` — types are erased, no runtime binding.
            if (typeKw) return `export type {${names}} from ${from}`
            const list = names
              .split(',')
              .map((n) => n.trim())
              .filter(Boolean)
              .map((n) => {
                const parts = n.split(/\s+as\s+/)
                return parts.length === 2
                  ? { local: parts[0].trim(), exported: parts[1].trim() }
                  : { local: n, exported: n }
              })
            // `default` can't be a plain `import { default }` binding — alias it to a
            // local name on the import side, then export it back out.
            const importNames = list
              .map((e, i) => (e.local === 'default' ? `default as __rngpuiDefault${auto}_${i}` : e.local))
              .join(', ')
            const exportNames = list
              .map((e, i) => {
                const localName = e.local === 'default' ? `__rngpuiDefault${auto}_${i}` : e.local
                return localName === e.exported ? e.exported : `${localName} as ${e.exported}`
              })
              .join(', ')
            auto++
            sideEffectSources.add(from)
            return `import { ${importNames} } from ${from};\nexport { ${exportNames} };`
          },
        )
        // `export * from './x'` star re-exports: keep them as-is (Bun re-exports the
        // namespace), but record the source so we pin it with a side-effect import too.
        for (const m of src.matchAll(/export\s*\*\s*from\s*(['"][^'"]+['"])/g)) {
          sideEffectSources.add(m[1])
        }
        // PIN every module reanimated imports. Bun's tree-shaker drops modules reached
        // only through re-export barrels / pure default imports and leaves their
        // namespace refs dangling (`import_xN is not defined`). A bare side-effect import
        // is never eliminated, so adding one for EVERY relative import in each reanimated
        // file forces the whole reanimated module graph to be retained intact. Module
        // *evaluation* order is unchanged (the side-effect import resolves to the same
        // module that the named/default import already pulls).
        for (const m of src.matchAll(/(?:import|export)\s[^;]*?from\s*(['"](\.[^'"]+)['"])/g)) {
          sideEffectSources.add(m[1])
        }
        // Default imports of a relative module (`import X from './y'`) are where Bun's
        // namespace binding breaks (`import_yN is not defined`). Rewrite each to a named
        // form (`import { default as X } from './y'`), which Bun binds correctly. Guard:
        // only `./`-relative sources (intra-reanimated), never react/jsx-runtime.
        rewritten = rewritten.replace(
          /import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]*)\}\s*from\s*(['"]\.[^'"]+['"])/g,
          (_m, def, named, from) => `import { default as ${def}, ${named} } from ${from}`,
        )
        rewritten = rewritten.replace(
          /import\s+([A-Za-z_$][\w$]*)\s+from\s*(['"]\.[^'"]+['"])/g,
          (_m, def, from) => `import { default as ${def} } from ${from}`,
        )
        for (const from of sideEffectSources) {
          rewritten = `import ${from};\n` + rewritten
        }
        // strip remaining bare `export type { … } from` lines for the TS loader (Bun
        // tolerates them, but keep the loader as ts). Pick loader by extension.
        const loader = args.path.endsWith('.tsx')
          ? 'tsx'
          : /\.(ts|mts|cts)$/.test(args.path)
            ? 'ts'
            : args.path.endsWith('.jsx')
              ? 'jsx'
              : 'js'
        return { contents: rewritten, loader }
      })

      // ── worklet transform ────────────────────────────────────────────────
      // gpui runs ONE Hermes runtime, so worklets execute as ordinary inline closures
      // (lexical capture works — no `this.__closure` indirection needed) and the babel
      // lift is only required for cross-runtime serialization, which we never do. The
      // transform is OPT-IN (RNGPUI_WORKLET_TRANSFORM=1) because under Bun's bundler the
      // worklet plugin reshapes reanimated's internal module exports in a way Bun can't
      // namespace (the `import_colorsN is not defined` class of error). Default off.
      if (!opts.workletTransform && process.env.RNGPUI_WORKLET_TRANSFORM !== '1') return
      build.onLoad({ filter: /\.(tsx?|jsx?|mjs|cjs)$/ }, async (args) => {
        if (IGNORED_PATHS.test(args.path)) return undefined
        // don't workletize our own seam/worklets stub.
        if (args.path === seamPath || args.path === workletsPath) return undefined
        const source = await Bun.file(args.path).text()
        if (!WORKLET_REGEX.test(source)) return undefined
        const isTsx = args.path.endsWith('.tsx')
        const isTs = /\.(tsx?|mts|cts)$/.test(args.path)
        const result = await getBabel().transformAsync(source, {
          filename: args.path,
          babelrc: false,
          configFile: false,
          sourceMaps: false,
          presets: isTs
            ? [[pluginRequire.resolve('@babel/preset-typescript'), { isTSX: isTsx, allExtensions: isTsx, allowDeclareFields: true }]]
            : [],
          plugins: [
            [pluginRequire.resolve('@babel/plugin-syntax-jsx')],
            [workletsPluginPath, { processNestedWorklets: true }],
          ],
        })
        if (!result?.code) return undefined
        // babel stripped TS types; the output is JS-with-JSX. Tell Bun it's jsx so it
        // finishes compiling the JSX the syntax plugin left intact.
        return { contents: result.code, loader: isTsx || /\.jsx$/.test(args.path) ? 'jsx' : 'js' }
      })
    },
  }
}
