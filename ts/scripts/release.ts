#!/usr/bin/env bun

/**
 * release script: check, build, publish react-native-gpui, commit, tag, push.
 * single-package port of the orez/one release.ts flavor.
 *
 *   bun scripts/release.ts --patch [--dry-run] [--skip-test] [--ci] [--dirty]
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const patch = args.includes('--patch')
const minor = args.includes('--minor')
const major = args.includes('--major')
const skipTest = args.includes('--skip-test') || args.includes('--skip-all')
const ci = args.includes('--ci')
const dirty = args.includes('--dirty')
const canPromptForNpmOtp = Boolean(input.isTTY && output.isTTY && !process.env.CI && !ci)

if (!patch && !minor && !major) {
  console.info(
    'usage: bun scripts/release.ts --patch|--minor|--major [--dry-run] [--skip-test] [--ci] [--dirty]'
  )
  process.exit(1)
}

const tsRoot = resolve(import.meta.dirname, '..')
const repoRoot = resolve(tsRoot, '..')

function run(cmd: string, opts?: { cwd?: string; silent?: boolean }) {
  const cwd = opts?.cwd ?? tsRoot
  if (!opts?.silent) console.info(`$ ${redactNpmOtp(cmd)}`)
  return execSync(cmd, { stdio: opts?.silent ? 'pipe' : 'inherit', cwd })
}

function capture(cmd: string, cwd = tsRoot) {
  return execSync(cmd, { encoding: 'utf8', cwd }).trim()
}

function isPublishAuthOrOtpError(message: string) {
  return /EOTP|one-time password|two-factor authentication|\botp\b/i.test(message)
}

function redactNpmOtp(command: string) {
  return command.replace(/--otp(?:=|\s+)\S+/g, '--otp=******')
}

let cachedNpmOtp = process.env.npm_config_otp || process.env.NPM_CONFIG_OTP

async function getNpmOtp(reason: string): Promise<string> {
  if (!canPromptForNpmOtp) {
    throw new Error(`${reason}\nNo TTY to prompt for an npm OTP — re-run with npm_config_otp set.`)
  }
  console.info(`\n${reason}`)
  const rl = createInterface({ input, output })
  try {
    while (true) {
      const code = (await rl.question('npm 2FA code (6 digits): ')).trim()
      if (/^\d{6}$/.test(code)) return code
      console.info('expected 6 digits')
    }
  } finally {
    rl.close()
  }
}

function bumpVersion(current: string): string {
  const base = current.split('-')[0]
  const [maj, min, pat] = base.split('.').map(Number)
  if (major) return `${maj + 1}.0.0`
  if (minor) return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

// guards
const branch = capture('git rev-parse --abbrev-ref HEAD')
if (branch !== 'main') {
  throw new Error(`release runs from main (on ${branch})`)
}
const status = capture('git status --porcelain', repoRoot)
if (status && !dirty) {
  throw new Error(`working tree not clean (pass --dirty to allow):\n${status}`)
}
run('npm whoami', { silent: true })

// bump ts/package.json and the private root package.json in lockstep
const pkgPath = join(tsRoot, 'package.json')
const rootPkgPath = join(repoRoot, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const next = bumpVersion(pkg.version)
console.info(`\nreact-native-gpui ${pkg.version} → ${next}${dryRun ? ' (dry run)' : ''}`)

if (!dryRun) {
  for (const [path, indent] of [
    [pkgPath, 2],
    [rootPkgPath, 4],
  ] as const) {
    const p = JSON.parse(readFileSync(path, 'utf8'))
    p.version = next
    writeFileSync(path, `${JSON.stringify(p, null, indent)}\n`)
  }
}

// verify before anything irreversible
run('npm run build')
run('npm run typecheck')
if (!skipTest) {
  run('npm test')
}

if (dryRun) {
  console.info('\n[dry-run] would publish, commit, tag, and push — stopping here')
  process.exit(0)
}

// publish. --ignore-scripts: prepublishOnly would redo the slow rust build we just ran
async function publishWithOtp() {
  const base = `npm publish --ignore-scripts${cachedNpmOtp ? ` --otp=${cachedNpmOtp}` : ''}`
  try {
    run(base)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!isPublishAuthOrOtpError(message)) throw err
    cachedNpmOtp = await getNpmOtp('npm publish needs a fresh 2FA code.')
    run(`npm publish --ignore-scripts --otp=${cachedNpmOtp}`)
  }
}
await publishWithOtp()

// commit exactly the two version files so co-tenant work is never swept in
run(`git commit -m "release: v${next}" -- package.json ../package.json`)
run(`git tag v${next}`)
run('git push origin HEAD --follow-tags')

console.info(`\nreleased react-native-gpui@${next}`)
