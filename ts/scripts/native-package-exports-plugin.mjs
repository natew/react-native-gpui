import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const packageJsonCache = new Map()

export function nativePackageExportsPlugin({ root, name = 'native package exports' } = {}) {
  const fallbackRoot = root ? resolve(root) : process.cwd()
  return {
    name,
    setup(build) {
      build.onResolve({ filter: /^[^./].*/ }, (args) =>
        resolveReactNativePackageExport(args.path, args.importer ? dirname(args.importer) : fallbackRoot)
      )
    },
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
