import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const packageJsonCache = new Map()

// Force React Native package entry points to win. Node/Bun pick the FIRST
// matching key in an export map, so a package that lists `browser` before
// `react-native` (nanoid, tamagui, on-zero, …) resolves to its DOM build even
// with `conditions: ['react-native']` set on the build. Bun also ignores the
// legacy top-level `react-native` field used by packages such as
// react-native-screens. This plugin overrides those, and only those.
//
// It must claim ONLY the packages it actually rewrites. A Bun 1.3.14 bundler bug
// makes an onResolve callback that MATCHES a specifier and returns `undefined`
// drop the module across an `export *` re-export edge — silently, with no build
// error, leaving a dangling namespace reference that throws at runtime
// ("Property 'import_manifest' doesn't exist"). A broad `/^[^./].*/` filter put
// every bare import in range of that bug to serve the ~7% that need the
// override. So the filter is built from the packages that really declare a
// react-native condition or entry point; everything else never enters the
// plugin and Bun resolves it natively. Keep that invariant: do not widen this
// filter.
export function nativePackageExportsPlugin({ root, name = 'native package exports' } = {}) {
  const fallbackRoot = root ? resolve(root) : process.cwd()
  const filter = reactNativePackageFilter(fallbackRoot)
  return {
    name,
    setup(build) {
      build.onResolve({ filter }, (args) =>
        resolveReactNativePackageExport(args.path, args.importer ? dirname(args.importer) : fallbackRoot)
      )
    },
  }
}

// every installed package whose export map declares a react-native condition
// or whose top-level react-native field names its native entry point:
// the root tree, the ancestor node_modules a workspace resolves through, and
// nested node_modules (a hoisted tree still nests duplicates). realpath dedup
// keeps a symlinked store from being walked twice or cycling. ~1800
// package.json reads, ~110ms, once per build.
function reactNativePackageFilter(root) {
  const names = new Set()
  const nodeModulesStack = []
  for (let dir = root; ; dir = dirname(dir)) {
    nodeModulesStack.push(join(dir, 'node_modules'))
    if (dir === dirname(dir)) break
  }
  const seenNodeModules = new Set()

  while (nodeModulesStack.length) {
    const nodeModules = nodeModulesStack.pop()
    let realNodeModules
    let entries
    try {
      realNodeModules = realpathSync(nodeModules)
      if (seenNodeModules.has(realNodeModules)) continue
      seenNodeModules.add(realNodeModules)
      entries = readdirSync(nodeModules, { withFileTypes: true })
    } catch {
      continue
    }

    const packageDirs = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const entryPath = join(nodeModules, entry.name)
      let directory
      try {
        directory = statSync(entryPath).isDirectory()
      } catch {
        directory = false
      }
      if (!directory) continue
      if (!entry.name.startsWith('@')) {
        packageDirs.push(entryPath)
        continue
      }
      let scopedEntries
      try {
        scopedEntries = readdirSync(entryPath, { withFileTypes: true })
      } catch {
        continue
      }
      for (const scopedEntry of scopedEntries) {
        const scopedPath = join(entryPath, scopedEntry.name)
        try {
          if (statSync(scopedPath).isDirectory()) packageDirs.push(scopedPath)
        } catch {}
      }
    }

    for (const packageDir of packageDirs) {
      const pkg = readPackageJson(join(packageDir, 'package.json'))
      const values = [pkg?.exports]
      let hasReactNativeTarget = false
      while (values.length && !hasReactNativeTarget) {
        const value = values.pop()
        if (!value || typeof value !== 'object') continue
        if (Object.prototype.hasOwnProperty.call(value, 'react-native')) {
          hasReactNativeTarget = true
          break
        }
        values.push(...Object.values(value))
      }
      if ((hasReactNativeTarget || typeof pkg?.['react-native'] === 'string') && pkg?.name) {
        names.add(pkg.name)
      }
      const nestedNodeModules = join(packageDir, 'node_modules')
      if (existsSync(nestedNodeModules)) nodeModulesStack.push(nestedNodeModules)
    }
  }

  if (!names.size) return /\b\B/
  const escaped = [...names]
    .sort()
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^(?:${escaped.join('|')})(?:/|$)`)
}

function resolveReactNativePackageExport(specifier, importer) {
  const parsed = parsePackageSpecifier(specifier)
  if (!parsed) return undefined
  let defaultPath
  try {
    defaultPath = Bun.resolveSync(specifier, importer)
  } catch {
    return undefined
  }
  const packageJsonPath = findPackageJson(parsed.name, defaultPath, importer)
  if (!packageJsonPath) return { path: defaultPath }
  const pkg = readPackageJson(packageJsonPath)
  if (!parsed.subpath && typeof pkg?.['react-native'] === 'string') {
    const nativeEntry = pkg['react-native'].startsWith('.')
      ? pkg['react-native']
      : `./${pkg['react-native']}`
    return { path: Bun.resolveSync(nativeEntry, dirname(packageJsonPath)) }
  }
  if (!pkg?.exports) return { path: defaultPath }
  const exportKey = parsed.subpath ? `.${parsed.subpath}` : '.'
  const match = exportValueForKey(pkg.exports, exportKey)
  if (!match) return { path: defaultPath }
  const target = preferredReactNativeTarget(match.value)
  // bun 1.3.9 can drop a re-exported module when a matching onResolve hook
  // returns undefined. once the narrowed filter matches a package name, every
  // successfully resolved subpath must return the path bun selected.
  if (!target) return { path: defaultPath }
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

function findPackageJson(packageName, resolvedPath, importer) {
  try {
    return Bun.resolveSync(`${packageName}/package.json`, importer)
  } catch {}
  return findPackageJsonAbove(resolvedPath, packageName)
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
