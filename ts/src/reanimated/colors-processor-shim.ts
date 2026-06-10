// Shim for react-native-reanimated's `common/style/processors/colors` module.
//
// Why: Bun's bundler mis-orders the init of reanimated's color-processor barrel
// (`config.ts`'s top-level `const colorAttributes = { process: processColor }` reads
// the binding before Bun assigns it → "Property 'processColorN' doesn't exist" at
// bundle eval). The original module also pulls a `'worklet'` `PlatformColor` and the
// deep `Colors.ts` chain. We replace ONLY this leaf with a self-contained module (all
// exports are hoisted declarations in one file, so there is no cross-module rename for
// Bun to drop), preserving the exact public surface the barrel re-exports.
//
// Faithfulness: `processColor` returns RN's 32-bit ARGB int (the same form upstream's
// `processColorInitially` produces), so reanimated's color interpolation + the gpui
// seam's `processedColorToCss` round-trip identically. `processColorsInProps` mutates
// color-valued style keys in place to that int form, matching upstream.

type StyleProps = Record<string, unknown>

const COLOR_KEYS = new Set([
  'color',
  'backgroundColor',
  'borderColor',
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
  'borderStartColor',
  'borderEndColor',
  'tintColor',
  'shadowColor',
  'overlayColor',
  'textDecorationColor',
  'textShadowColor',
])

// RN-style color string/number → 32-bit ARGB int (a>>24, r>>16, g>>8, b). Mirrors
// react-native's processColor output so reanimated's color interpolation operates on
// the same numeric form it expects.
export function processColor(color: unknown): number | null {
  if (color == null) return null
  if (typeof color === 'number') return color >>> 0
  if (typeof color !== 'string') return null
  const s = color.trim()
  let m: RegExpExecArray | null
  if ((m = /^#([0-9a-f]{6})$/i.exec(s))) return (0xff000000 | parseInt(m[1], 16)) >>> 0
  if ((m = /^#([0-9a-f]{8})$/i.exec(s))) {
    const n = parseInt(m[1], 16)
    const a = n & 0xff
    return (((a << 24) | (n >>> 8)) >>> 0) >>> 0
  }
  if ((m = /^#([0-9a-f]{3})$/i.exec(s))) {
    const h = m[1]
    const r = parseInt(h[0] + h[0], 16)
    const g = parseInt(h[1] + h[1], 16)
    const b = parseInt(h[2] + h[2], 16)
    return (0xff000000 | (r << 16) | (g << 8) | b) >>> 0
  }
  if ((m = /^rgba?\(([^)]+)\)$/i.exec(s))) {
    const p = m[1].split(',').map((x) => x.trim())
    const r = parseInt(p[0]) || 0
    const g = parseInt(p[1]) || 0
    const b = parseInt(p[2]) || 0
    let a = p[3] === undefined ? 1 : parseFloat(p[3])
    if (!(a >= 0)) a = 0
    if (a > 1) a = 1
    return ((((a * 255) & 0xff) << 24) | (r << 16) | (g << 8) | b) >>> 0
  }
  // named colors / unknown → opaque black (matches RN's fallback shape closely enough).
  return 0xff000000 >>> 0
}

export function processColorNumber(value: unknown): number | null {
  return processColor(value)
}

export function processColorsInProps(props: StyleProps): void {
  for (const key of Object.keys(props)) {
    if (COLOR_KEYS.has(key)) {
      const processed = processColor(props[key])
      if (processed != null) props[key] = processed
    }
  }
}

// PlatformColor / DynamicColorIOS — gpui has no native semantic colors; identity-ish.
export function PlatformColor(...names: string[]): unknown {
  return names[0]
}

export function DynamicColorIOS(tuple: { light: unknown; dark: unknown }): unknown {
  return tuple?.light
}

// ── worklet-builtin registration ─────────────────────────────────────────────
// Upstream's updateProps worklet CAPTURES processColorsInProps in its closure.
// These shim fns are plain (not babel-workletized), so without a builtin brand
// the cross-runtime serializer ships them as async jsCallback proxies — on the
// worklet/UI runtime they then do nothing and every color key crosses as
// undefined (the dropped-dialog-bg bug). Brand + register them so closures
// serialize as {kind:'builtin', name} and bind to THIS module's implementation
// on whichever runtime executes (this shim is baked into the prebuilt chunk,
// which evaluates on both). Constants mirror worklet-runtime.ts — this file
// cannot import it (the prebuilt chunk keeps the worklets package external).
const RNGPUI_BUILTIN_NAME = Symbol.for('rngpui.workletBuiltinName')
function registerColorBuiltin(name: string, fn: (...args: never[]) => unknown): void {
  try {
    Object.defineProperty(fn, RNGPUI_BUILTIN_NAME, {
      value: name,
      enumerable: false,
      configurable: true,
      writable: false,
    })
  } catch {}
  const g = globalThis as unknown as { __rngpui_worklet_builtins?: Map<string, unknown> }
  if (!g.__rngpui_worklet_builtins) g.__rngpui_worklet_builtins = new Map()
  g.__rngpui_worklet_builtins.set(name, fn)
}
registerColorBuiltin('processColor', processColor)
registerColorBuiltin('processColorNumber', processColorNumber)
registerColorBuiltin('processColorsInProps', processColorsInProps)
