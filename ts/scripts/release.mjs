#!/usr/bin/env node
// release react-native-gpui: bump version, build, publish to npm, tag, push.
//
//   npm run release            # patch bump + publish + tag + push
//   npm run release -- --minor
//   npm run release -- --dry-run      # everything except publish/commit/push
//   npm run release -- --no-publish   # bump/build/commit/tag/push, skip npm
//   npm run release -- --dirty        # allow uncommitted files (co-tenant work)
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const tsDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const rootDir = join(tsDir, '..')
const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const dryRun = has('--dry-run')
const publish = !has('--no-publish') && !dryRun
const bumpKind = has('--major') ? 'major' : has('--minor') ? 'minor' : 'patch'

const sh = (cmd, opts = {}) => {
  console.log(`$ ${cmd}`)
  return execSync(cmd, { stdio: 'inherit', cwd: tsDir, ...opts })
}
const out = (cmd, opts = {}) =>
  execSync(cmd, { encoding: 'utf8', cwd: tsDir, ...opts }).trim()

// guards
const branch = out('git rev-parse --abbrev-ref HEAD')
if (branch !== 'main') {
  console.error(`release runs from main (on ${branch})`)
  process.exit(1)
}
const status = out('git status --porcelain', { cwd: rootDir })
if (status && !has('--dirty')) {
  console.error(`working tree not clean (pass --dirty to allow):\n${status}`)
  process.exit(1)
}
if (publish) out('npm whoami') // fail early if npm auth is missing

// bump ts/package.json and the private root package.json in lockstep
const bump = (path) => {
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  const [maj, min, pat] = pkg.version.split('.').map(Number)
  pkg.version =
    bumpKind === 'major'
      ? `${maj + 1}.0.0`
      : bumpKind === 'minor'
        ? `${maj}.${min + 1}.0`
        : `${maj}.${min}.${pat + 1}`
  if (!dryRun) writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
  return pkg.version
}
const version = bump(join(tsDir, 'package.json'))
bump(join(rootDir, 'package.json'))
console.log(`version: ${version}${dryRun ? ' (dry run, not written)' : ''}`)

// verify before anything irreversible: full build (rust service + native
// deliverable + ts dist) and a typecheck
sh('npm run build')
sh('npm run typecheck')

if (dryRun) {
  console.log('dry run: skipping publish/commit/tag/push')
  process.exit(0)
}

if (publish) {
  // --ignore-scripts: prepublishOnly would redo the slow rust build we just ran
  sh('npm publish --ignore-scripts')
}

// commit exactly the two version files so co-tenant work is never swept in
sh(`git commit -m "release: v${version}" -- package.json ../package.json`)
sh(`git tag v${version}`)
sh('git push origin HEAD --follow-tags')

console.log(`\nreleased react-native-gpui@${version}`)
console.log('consumers: bun add react-native-gpui@latest (agentbus gui: bun run sync:gpui still works for local dev via RNGPUI_LOCAL)')
