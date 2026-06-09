// Pre-bundle real react-native-reanimated@4 (and @tamagui/animations-reanimated) into
// self-contained ESM chunks with ESBUILD — which, unlike Bun's bundler, handles
// reanimated's re-export-barrel module graph WITHOUT the tree-shake-then-dangle bug
// (`import_xN is not defined`). This mirrors soot's `build-bundler-deps` pipeline:
// esbuild bundles each dep once, with react / react-native / react-native-worklets /
// react-native-gpui kept EXTERNAL so the app bundle supplies one shared runtime copy.
//
//   bun scripts/prebuild-reanimated.mjs [outDir]   (default: ts/.reanimated-prebuilt)
//
// Produces:
//   <outDir>/react-native-reanimated.mjs       — the whole package, one ESM file
//   <outDir>/tamagui-animations-reanimated.mjs — the Tamagui native driver, one file
//
// Both keep `react-native-reanimated`, `react-native-worklets`, `react-native`,
// `react`, `react-native-gpui`, `@tamagui/*` external (resolved at app-bundle time:
// the app aliases `react-native-reanimated` → the first chunk, `react-native-worklets`
// → the single-runtime stub, etc.). esbuild runs the worklets babel transform + a Flow
// strip on RN source via onLoad, exactly like soot.

import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { dirname, resolve, sep } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const tsRoot = resolve(import.meta.dirname, '..')
const outDir = resolve(process.argv[2] || resolve(tsRoot, '.reanimated-prebuilt'))
mkdirSync(outDir, { recursive: true })

// resolveRoot — where reanimated / @tamagui/animations-reanimated are installed. Defaults
// to rng-ts; override (RNGPUI_PREBUILD_RESOLVE_ROOT) to prebuild from another project's
// node_modules (e.g. the gui, which has the full tamagui stack) without installing it here.
const resolveRoot = resolve(process.env.RNGPUI_PREBUILD_RESOLVE_ROOT || tsRoot)
// babel/esbuild/worklets-plugin always resolve from rng-ts (the toolchain lives here).
const pluginRequire = createRequire(resolve(tsRoot, 'package.json'))
const pkgRequire = createRequire(resolve(resolveRoot, 'package.json'))
const seamPath = resolve(tsRoot, 'src/reanimated/seam.ts')
const colorsShim = resolve(tsRoot, 'src/reanimated/colors-processor-shim.ts')

// ── worklets babel transform (lift `'worklet'` fns to __initData/__closure/__workletHash)
const babel = pluginRequire('@babel/core')
const workletsPlugin = pluginRequire.resolve('react-native-worklets/plugin')
const jsxSyntax = pluginRequire.resolve('@babel/plugin-syntax-jsx')
const presetTs = pluginRequire.resolve('@babel/preset-typescript')
const flowStrip = pluginRequire.resolve('@babel/plugin-transform-flow-strip-types')

const WORKLET_KEYWORDS =
  /worklet|useAnimatedStyle|useAnimatedProps|useDerivedValue|useAnimatedReaction|useAnimatedGestureHandler|useAnimatedScrollHandler|useFrameCallback|useWorkletCallback|withTiming|withSpring|withDecay|withDelay|withRepeat|runOnUI|createAnimatedPropAdapter|executeOnUIRuntimeSync/

// reanimated platform-function basenames whose native side we replace with the seam.
const SEAM_BASENAMES = new Set([
  'scrollTo',
  'measure',
  'setNativeProps',
  'dispatchCommand',
  'setGestureState',
])

// RN-internal subpath shims (same set the Bun plugin provides — kept here so the chunk
// is self-contained vs RN internals; bare `react-native` stays external).
const RN_INTERNAL_SHIMS = [
  {
    re: /react-native\/Libraries\/StyleSheet\/processColor(\.js)?$/,
    contents: `
      function processColor(color){
        if (color == null) return null;
        if (typeof color === 'number') return color >>> 0;
        if (typeof color !== 'string') return null;
        var s = color.trim(); var m;
        if ((m = /^#([0-9a-f]{6})$/i.exec(s))) return (0xff000000 | parseInt(m[1],16)) >>> 0;
        if ((m = /^#([0-9a-f]{8})$/i.exec(s))) { var n=parseInt(m[1],16); var a=n&0xff; return (((a<<24)|(n>>>8))>>>0); }
        if ((m = /^#([0-9a-f]{3})$/i.exec(s))) { var h=m[1]; var r=parseInt(h[0]+h[0],16),g=parseInt(h[1]+h[1],16),b=parseInt(h[2]+h[2],16); return (0xff000000|(r<<16)|(g<<8)|b)>>>0; }
        if ((m = /^rgba?\\(([^)]+)\\)$/i.exec(s))) { var p=m[1].split(',').map(function(x){return x.trim()}); var r=parseInt(p[0])||0,g=parseInt(p[1])||0,b=parseInt(p[2])||0; var a=p[3]===undefined?1:parseFloat(p[3]); if(!(a>=0))a=0; if(a>1)a=1; return ((((a*255)&0xff)<<24)|(r<<16)|(g<<8)|b)>>>0; }
        return 0xff000000>>>0;
      }
      module.exports = processColor; module.exports.default = processColor;`,
  },
  {
    re: /react-native\/Libraries\/StyleSheet\/normalizeColor(\.js)?$/,
    contents: `module.exports = require('react-native/Libraries/StyleSheet/processColor');`,
  },
  { re: /react-native\/Libraries\/Components\/View\/ReactNativeStyleAttributes$/, contents: `module.exports = {};` },
  {
    re: /react-native\/Libraries\/Renderer\/shims\/ReactFabric$/,
    contents: `function findHostInstance_DEPRECATED(){ throw new Error('rngpui: findHostInstance_DEPRECATED unavailable'); }
               module.exports = { findHostInstance_DEPRECATED: findHostInstance_DEPRECATED }; module.exports.default = module.exports;`,
  },
  {
    re: /react-native\/Libraries\/TurboModule\/TurboModuleRegistry$/,
    contents: `function get(){ return null; } function getEnforcing(){ return {}; }
               module.exports = { get: get, getEnforcing: getEnforcing }; module.exports.default = module.exports;`,
  },
  { re: /react-native\/Libraries\/Core\/setUpXHR$/, contents: `module.exports = {};` },
  {
    re: /react-native\/Libraries\/StyleSheet\/PlatformColorValueTypes(IOS)?(\.d\.ts)?$/,
    contents: `function PlatformColor(){return undefined;} function DynamicColorIOS(){return undefined;}
               module.exports = { PlatformColor, DynamicColorIOS, normalizeColorObject:(c)=>c, processColorObject:(c)=>c }; module.exports.default = module.exports;`,
  },
]
const RN_SHIM_NS = 'rngpui-rn-internal'

const nodeModulesSep = `${sep}node_modules${sep}`

function loaderForPath(p) {
  if (p.endsWith('.tsx')) return 'tsx'
  if (/\.(ts|mts|cts)$/.test(p)) return 'ts'
  if (p.endsWith('.jsx')) return 'jsx'
  return 'js'
}

// esbuild plugin: seam redirect + RN aliases + Flow strip + worklets transform.
const reanimatedSeamPlugin = {
  name: 'reanimated-seam',
  setup(b) {
    // NOTE: `react-native` is kept EXTERNAL (see the prebuild `external` lists) so the
    // chunk emits `import { View } from "react-native"` and the APP bundle resolves it
    // to the single gpui RN-compatible index — otherwise esbuild would inline the whole
    // gpui renderer (react-reconciler + scheduler) into the chunk, creating a second
    // reconciler copy. We only inline the RN-INTERNAL subpath shims below.
    // RN-internal subpaths → inline shims.
    b.onResolve({ filter: /^react-native\/Libraries\// }, (args) => {
      if (RN_INTERNAL_SHIMS.some((s) => s.re.test(args.path))) {
        return { path: args.path, namespace: RN_SHIM_NS }
      }
      return undefined
    })
    b.onLoad({ filter: /.*/, namespace: RN_SHIM_NS }, (args) => {
      const shim = RN_INTERNAL_SHIMS.find((s) => s.re.test(args.path))
      return { contents: shim ? shim.contents : 'module.exports = {};', loader: 'js' }
    })

    // reanimated native-seam files (the turbomodule + platformFunctions) → seam.
    b.onResolve({ filter: /\.\.?\// }, (args) => {
      if (!args.importer || !args.importer.includes('react-native-reanimated')) return undefined
      if (args.importer === seamPath) return undefined
      const base = (args.path.split('/').pop() ?? '').replace(/\.(native|web|ios|android)$/, '')
      // the native turbomodule (`specs/NativeReanimatedModule`) imports
      // `TurboModuleRegistry` from react-native (absent on gpui); redirect it to the
      // seam, whose default export is `{ installTurboModule }` — same as soot.
      if (base === 'NativeReanimatedModule') return { path: seamPath }
      const inPlatformFns =
        args.path.includes('platformFunctions') || args.importer.includes('platformFunctions')
      if (inPlatformFns && SEAM_BASENAMES.has(base)) return { path: seamPath }
      // reanimated's color processor leaf → our shim (its deep Colors chain + a
      // 'worklet' PlatformColor are noise on the single-runtime native path).
      if (base === 'colors' && args.importer.includes('common/style/processors')) {
        return { path: colorsShim }
      }
      return undefined
    })

    // synthetic react-native-worklets/package.json (assertWorkletsVersion requires it).
    b.onResolve({ filter: /^react-native-worklets\/package\.json$/ }, () => ({
      path: 'rnw-pkgjson',
      namespace: 'rngpui-virtual',
    }))
    b.onLoad({ filter: /^rnw-pkgjson$/, namespace: 'rngpui-virtual' }, () => ({
      contents: JSON.stringify({ name: 'react-native-worklets', version: '0.8.1' }),
      loader: 'json',
    }))

    // Flow strip (some RN/reanimated source ships `@flow`).
    b.onLoad({ filter: /\.[cm]?jsx?$/ }, (args) => {
      if (args.namespace && args.namespace !== 'file') return undefined
      if (!args.path.includes(nodeModulesSep)) return undefined
      const source = readFileSync(args.path, 'utf8')
      if (!source.includes('@flow')) return undefined
      const result = babel.transformSync(source, {
        filename: args.path,
        babelrc: false,
        configFile: false,
        plugins: [flowStrip, jsxSyntax],
        sourceMaps: false,
        compact: false,
      })
      if (!result?.code) return undefined
      return { contents: result.code, loader: 'jsx', resolveDir: dirname(args.path) }
    })

    // worklets babel transform — REQUIRED. The babel lift attaches `__closure` (the
    // SharedValues a worklet captures) to reanimated's hooks, which `useAnimatedStyle`/
    // `useDerivedValue` read to build their mapper INPUTS. Without it the mapper
    // subscribes to nothing, a `sv.value = …` write never re-runs the updater, and a
    // spring snaps to its target instead of animating. The lifted function still runs
    // with LEXICAL scope on gpui's single runtime (the `this.__closure` form lives only
    // in `__initData.code`, the cross-runtime serialization string we never eval), so
    // the per-frame `frame()` rAF loop keeps re-firing. Content-gated by keyword.
    b.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
      if (args.namespace && args.namespace !== 'file') return undefined
      if (args.path === seamPath || args.path === colorsShim) return undefined
      const source = readFileSync(args.path, 'utf8')
      if (!WORKLET_KEYWORDS.test(source)) return undefined
      const isTsx = args.path.endsWith('.tsx')
      const isTs = /\.(tsx?|mts|cts)$/.test(args.path)
      const result = babel.transformSync(source, {
        filename: args.path,
        babelrc: false,
        configFile: false,
        sourceMaps: false,
        presets: isTs ? [[presetTs, { isTSX: isTsx, allExtensions: isTsx, allowDeclareFields: true }]] : [],
        plugins: [[jsxSyntax], [workletsPlugin, { processNestedWorklets: true }]],
      })
      if (!result?.code) return undefined
      return { contents: result.code, loader: isTsx || args.path.endsWith('.jsx') ? 'jsx' : 'js', resolveDir: dirname(args.path) }
    })
  },
}

const SHARED_DEFINE = {
  'process.env.NODE_ENV': '"production"',
  'process.env.TAMAGUI_TARGET': '"native"',
  __DEV__: 'false',
}

async function prebuild(label, entry, outFile, external) {
  const result = await build({
    bundle: true,
    format: 'esm',
    write: false,
    minify: false,
    keepNames: true,
    target: 'esnext',
    // automatic JSX → `react/jsx-runtime` imports (external, resolved at app-bundle
    // time). reanimated's source JSX otherwise compiles to classic `React.createElement`
    // expecting a bare `React` in scope, which the chunk doesn't bind.
    jsx: 'automatic',
    jsxImportSource: 'react',
    platform: 'neutral',
    mainFields: ['react-native', 'module', 'main'],
    conditions: ['react-native', 'import', 'require'],
    resolveExtensions: ['.native.tsx', '.native.ts', '.native.js', '.tsx', '.ts', '.js', '.mjs', '.json'],
    tsconfigRaw: { compilerOptions: { useDefineForClassFields: false } },
    define: SHARED_DEFINE,
    logLevel: 'warning',
    external,
    stdin: { contents: entry, resolveDir: resolveRoot, sourcefile: `${label}-entry.ts`, loader: 'ts' },
    plugins: [reanimatedSeamPlugin],
  })
  const code = result.outputFiles[0].text
  writeFileSync(outFile, code)
  console.log(`[prebuild-reanimated] wrote ${outFile} (${(code.length / 1024).toFixed(0)} KB)`)
}

// chunk 1: the whole reanimated package, re-exported. Worklets stays external (the app
// aliases it to the single-runtime stub, which force-imports the seam).
await prebuild(
  'reanimated',
  `export * from 'react-native-reanimated';\nexport { default } from 'react-native-reanimated';`,
  resolve(outDir, 'react-native-reanimated.mjs'),
  ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-native', 'react-native-worklets', 'react-native-gpui'],
)

// chunk 2: the Tamagui native reanimated driver. reanimated + tamagui stay external.
const tamaguiAnimReanimated = (() => {
  try {
    return pkgRequire.resolve('@tamagui/animations-reanimated')
  } catch {
    return null
  }
})()
if (tamaguiAnimReanimated) {
  await prebuild(
    'tamagui-animations-reanimated',
    `export * from '@tamagui/animations-reanimated';\nexport { default } from '@tamagui/animations-reanimated';`,
    resolve(outDir, 'tamagui-animations-reanimated.mjs'),
    [
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-native',
      'react-native-worklets',
      'react-native-gpui',
      'react-native-reanimated',
      '@tamagui/core',
      '@tamagui/web',
      'tamagui',
    ],
  )
} else {
  console.log('[prebuild-reanimated] @tamagui/animations-reanimated not installed; skipping that chunk')
}

if (!existsSync(resolve(outDir, 'react-native-reanimated.mjs'))) {
  console.error('[prebuild-reanimated] FAILED: reanimated chunk not written')
  process.exit(1)
}
