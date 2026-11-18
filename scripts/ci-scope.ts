import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export type CiScope = { memory: boolean, granite: boolean, package: boolean, fallback: boolean, paths: string[] }
type EventPayload = {
  before?: unknown, after?: unknown,
  pull_request?: { base?: { sha?: unknown }, head?: { sha?: unknown } },
}
type Comparison = { base: string, head: string, mergeBase: boolean }

const MEMORY_WATCH = Object.freeze([
  'src/memory/**', 'plugins/memory/**', 'plugins/trace/**', 'src/shared/**',
  'src/backend/remote-memory-channel.ts', 'src/backend/compose.ts', 'src/backend/app-plugins.ts',
  'src/backend/acp-bridge.ts', 'src/backend/dsh-lifecycle.ts',
  'src/backend/memory-*.ts', 'src/backend/history-*.ts', 'src/backend/task-*.ts',
  'src/backend/schedule-*.ts', 'src/backend/request-*.ts',
  'test/memory*.test.*', 'test/fixtures/**', 'test/smoke/**',
  'package.json', 'package-lock.json', 'scripts/build*', 'scripts/test-*', 'scripts/ci-scope.ts',
  '.github/workflows/check.yml', '.github/workflows/memory.yml', '.github/workflows/package.yml',
  '.github/workflows/full.yml', '.github/workflows/daily.yml', '.github/workflows/release.yml',
])
// Production retrieval, its pinned offline runtime, and the two frozen evaluation suites.
const GRANITE_WATCH = Object.freeze([
  'src/memory/core/memory-file-*.ts', 'src/memory/core/memory-document*.ts', 'src/memory/core/memory-markdown.ts',
  'src/memory/core/memory-daily-search.ts', 'src/memory/core/memory-runtime.ts', 'src/memory/core/search-tokens.ts',
  'src/memory/core/ports/file-index.ts', 'src/memory/contracts/**', 'src/memory/node/memory-file-index.ts',
  'src/memory/node/memory-embed*.ts', 'src/memory/node/sqlite.ts', 'build/memory-embedding/**',
  'scripts/memory-embedding-recipe.ts', 'scripts/prepare-memory-embedding.ts', 'scripts/memory-file-evaluation.ts',
  'test/fixtures/memory-file-evaluation.ts', 'test/fixtures/memory-file-validation*',
  'package.json', 'package-lock.json', 'scripts/ci-scope.ts', '.github/workflows/check.yml',
])
const PACKAGE_WATCH = Object.freeze([
  'package.json', 'package-lock.json', 'build/**', 'scripts/**', 'tsconfig*.json',
  'src/memory/**', 'plugins/memory/**', 'src/backend/config.ts', 'src/backend/app-plugins.ts',
  'src/shell/automation-driver.ts', 'test/memory-package.test.ts', 'test/smoke/**', 'test/fixtures/**',
  '.github/workflows/check.yml', '.github/workflows/package.yml', '.github/workflows/full.yml',
  '.github/workflows/daily.yml', '.github/workflows/release.yml',
])

function matches(file: string, pattern: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*|\*/g, star => star === '**' ? '.*' : '[^/]*')
  return new RegExp(`^${source}$`).test(file)
}

export function changedPaths(nameStatus: string): string[] {
  const fields = nameStatus.split('\0')
  if (fields.at(-1) === '') fields.pop()
  const paths: string[] = []
  for (let index = 0; index < fields.length;) {
    const status = fields[index++] ?? ''
    if (/^[RC]/.test(status)) {
      const before = fields[index++], after = fields[index++]
      if (before) paths.push(before)
      if (after) paths.push(after)
    } else {
      const file = fields[index++]
      if (file) paths.push(file)
    }
    if (!status) throw new Error('Invalid git name-status output')
  }
  return [...new Set(paths)]
}

export function scopeForPaths(paths: readonly string[]): CiScope {
  return {
    memory: paths.some(file => MEMORY_WATCH.some(pattern => matches(file, pattern))),
    granite: paths.some(file => GRANITE_WATCH.some(pattern => matches(file, pattern))),
    package: paths.some(file => PACKAGE_WATCH.some(pattern => matches(file, pattern))),
    fallback: false,
    paths: [...paths],
  }
}

function comparison(eventName: string, payload: EventPayload): Comparison | null {
  if (eventName === 'pull_request') {
    const base = payload.pull_request?.base?.sha, head = payload.pull_request?.head?.sha
    return validSha(base) && validSha(head) ? { base, head, mergeBase: true } : null
  }
  if (eventName === 'push') {
    const before = payload.before, after = payload.after
    return validSha(before) && validSha(after) && !/^0+$/.test(before) ? { base: before, head: after, mergeBase: false } : null
  }
  throw new Error(`Unsupported scope event: ${eventName}`)
}

const validSha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
const fullScope = (): CiScope => ({ memory: true, granite: true, package: true, fallback: true, paths: [] })

export function scopeForEvent(eventName: string, payload: EventPayload, readDiff: (comparison: Comparison) => string): CiScope {
  const selected = comparison(eventName, payload)
  if (!selected) return fullScope()
  try {
    return scopeForPaths(changedPaths(readDiff(selected)))
  } catch {
    return fullScope()
  }
}

export function runCiScope(eventName = process.env.GITHUB_EVENT_NAME ?? '', eventFile = process.env.GITHUB_EVENT_PATH): CiScope {
  if (!eventFile) throw new Error('GITHUB_EVENT_PATH is required')
  const payload = JSON.parse(fs.readFileSync(eventFile, 'utf8'))
  return scopeForEvent(eventName, payload, selected => {
    const base = selected.mergeBase
      ? execFileSync('git', ['merge-base', selected.base, selected.head], { encoding: 'utf8' }).trim()
      : selected.base
    return execFileSync('git', ['diff', '--name-status', '-M', '-z', `${base}..${selected.head}`], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    })
  })
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const scope = runCiScope()
  const output = process.env.GITHUB_OUTPUT
  if (output) fs.appendFileSync(output, `memory-required=${scope.memory}\ngranite-required=${scope.granite}\npackage-required=${scope.package}\nscope-fallback=${scope.fallback}\n`)
  console.log(JSON.stringify({ memoryRequired: scope.memory, graniteRequired: scope.granite, packageRequired: scope.package, fallback: scope.fallback, paths: scope.paths }))
}
