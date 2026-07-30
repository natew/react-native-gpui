import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const packageJsonCache = new Map()

// Force the `react-native` export condition to win. Node/Bun pick the FIRST
// matching key in an export map, so a package that lists `browser` before
// `react-native` (nanoid, tamagui, on-zero, …) resolves to its DOM build even
// with `conditions: ['react-native']` set on the build. This plugin overrides
// those, and only those.
//
// It must claim ONLY the packages it actually rewrites. A Bun 1.3.14 bundler bug
// makes an onResolve callback that MATCHES a specifier and returns `undefined`
// drop the module across an `export *` re-export edge — silently, with no build
// error, leaving a dangling namespace reference that throws at runtime
// ("Property 'import_manifest' doesn't exist"). A broad `/^[^./].*/` filter put
// every bare import in range of that bug to serve the ~7% that need the
// override. So the filter is built from the packages that really declare a
// react-native condition; everything else never enters the plugin and Bun
// resolves it natively. Keep that invariant: do not widen this filter.
export function nativePackageExportsPlugin({ root, name = 'native package exports' } = {}) {
  const fallbackRoot = root ? resolve(root) : process.cwd()
  const owned = packagesWithReactNativeCondition(fallbackRoot)
  if (!owned.size) return { name, setup() {} }
  const filter = new RegExp(`^(?:${[...owned].map(escapeRegExp).join('|')})(?:/.*)?$`)
  return {
    name,
    setup(build) {
      build.onResolve({ filter }, (args) =>
        resolveReactNativePackageExport(args.path, args.importer ? dirname(args.importer) : fallbackRoot)
      )
    },
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// every installed package whose export map mentions a react-native condition,
// including nested node_modules (a hoisted tree still nests duplicates). ~1800
// package.json reads, ~110ms, once per build.
function packagesWithReactNativeCondition(root) {
  const names = new Set()
  for (let dir = root; ; dir = dirname(dir)) {
    scanPackageDir(join(dir, 'node_modules'), names, 0)
    if (dir === dirname(dir)) break
  }
  return names
}

const MAX_NESTED_DEPTH = 6

function scanPackageDir(dir, names, depth) {
  if (depth > MAX_NESTED_DEPTH) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    // @scope/ is a directory of packages, not a package.
    if (entry.name.startsWith('@')) {
      scanPackageDir(full, names, depth)
      continue
    }
    const pkg = readPackageJson(join(full, 'package.json'))
    if (pkg?.name && pkg.exports && JSON.stringify(pkg.exports).includes('"react-native"')) {
      names.add(pkg.name)
    }
    scanPackageDir(join(full, 'node_modules'), names, depth + 1)
  }
}

function resolveReactNativePackageExport(specifier, importer) {
  const parsed = parsePackageSpecifier(specifier)
  if (!parsed) return undefined
  const packageJsonPath = findPackageJson(parsed.name, specifier, importer)
  if (!packageJsonPath) return undefined
  const pkg = readPackageJson(packageJsonPath)
  if (!pkg?.exports) return undefined
  const exportKey = parsed.subpath ? `.${parsed.subpath}` : '.'
  const match = exportValueForKey(pkg.exports, exportKey)
  if (!match) return undefined
  const target = preferredReactNativeTarget(match.value)
  if (!target) return undefined
  const path = match.pattern ? target.replaceAll('*', match.pattern) : target
  return { path: resolve(dirname(packageJsonPath), path) }
}

function parsePackageSpecifier(specifier) {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:') ||
    /^[a-zA-Z]+:/.test(specifier)
  ) {
    return null
  }
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const subpath = specifier.slice(name.length) || ''
  return { name, subpath }
}

function findPackageJson(packageName, specifier, importer) {
  try {
    return Bun.resolveSync(`${packageName}/package.json`, importer)
  } catch {}
  try {
    return findPackageJsonAbove(Bun.resolveSync(specifier, importer), packageName)
  } catch {
    return null
  }
}

function findPackageJsonAbove(resolvedPath, packageName) {
  let dir = dirname(resolvedPath)
  while (dir !== dirname(dir)) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate) && readPackageJson(candidate)?.name === packageName) return candidate
    dir = dirname(dir)
  }
  return null
}

function readPackageJson(path) {
  if (packageJsonCache.has(path)) return packageJsonCache.get(path)
  let value = null
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {}
  packageJsonCache.set(path, value)
  return value
}

function exportValueForKey(exports, key) {
  if (key === '.' && (typeof exports === 'string' || Array.isArray(exports))) {
    return { value: exports }
  }
  if (!exports || typeof exports !== 'object' || Array.isArray(exports)) return null
  if (Object.prototype.hasOwnProperty.call(exports, key)) return { value: exports[key] }
  if (key === '.' && isConditionalExport(exports)) return { value: exports }
  for (const [pattern, value] of Object.entries(exports)) {
    if (!pattern.includes('*')) continue
    const [prefix, suffix] = pattern.split('*')
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue
    return { value, pattern: key.slice(prefix.length, key.length - suffix.length) }
  }
  return null
}

function isConditionalExport(value) {
  return Object.keys(value).some((key) => !key.startsWith('.'))
}

function preferredReactNativeTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (!Object.prototype.hasOwnProperty.call(value, 'react-native')) return null
  return preferredExportTarget(value['react-native'])
}

function preferredExportTarget(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = preferredExportTarget(item)
      if (target) return target
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  for (const key of ['import', 'default', 'require']) {
    const target = preferredExportTarget(value[key])
    if (target) return target
  }
  return null
}
