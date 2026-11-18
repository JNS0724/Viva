import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parse } from 'yaml'
import { changedPaths, scopeForEvent, scopeForPaths } from '../scripts/ci-scope.ts'

type Step = { run?: string, uses?: string, if?: string, env?: Record<string, string>, with?: Record<string, unknown> }
type Job = {
  name?: string, 'runs-on'?: string, if?: string, needs?: string[], uses?: string, 'timeout-minutes'?: number,
  strategy?: { 'fail-fast': boolean, matrix: { include: { os: string, package: string }[] } },
  steps?: Step[],
}
const workflow = (name: string) => parse(fs.readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8')) as { jobs: Record<string, Job> }
const { jobs } = workflow('check')
const gate = jobs.check
const commands = (job: Job) => (job.steps ?? []).flatMap(step => step.run ? [step.run] : [])

test('each PR platform runs the basic tests and builds its own installer', () => {
  assert.deepEqual(Object.keys(jobs), ['check'])
  assert.equal(gate.name, 'check (${{ matrix.os }})')
  assert.equal(gate['runs-on'], '${{ matrix.os }}')
  assert.equal(gate.strategy!['fail-fast'], false)
  assert.deepEqual(gate.strategy!.matrix.include, [
    { os: 'macos-latest', package: 'dist:mac' },
    { os: 'windows-latest', package: 'dist:win' },
  ])
  assert.deepEqual(commands(gate), ['npm ci', 'npm run typecheck', 'npm run test:pr', 'npm run ${{ matrix.package }}'])
})

test('full and daily workflows retain diagnostics and package owns offline installation', () => {
  const full = workflow('full').jobs.full
  assert.equal(full['timeout-minutes'], 45)
  for (const command of ['npm run typecheck', 'npm run check:i18n', 'npm run test:source', 'npm run smoke', 'npm run smoke:perf']) {
    assert.ok(commands(full).includes(command))
  }
  assert.equal(commands(full).includes('npm run build'), false)
  const smokeRuns = full.steps!.filter(step => step.env?.VIVA_SMOKE_RUN).map(step => step.env!.VIVA_SMOKE_RUN)
  assert.equal(new Set(smokeRuns).size, 2)
  assert.ok(smokeRuns[0].includes('full-source'))
  assert.ok(smokeRuns[1].includes('full-performance'))
  const uploads = full.steps!.filter(step => step.uses === 'actions/upload-artifact@v4')
  assert.equal(uploads.length, 2)
  assert.ok(uploads.every(step => step.if === 'always()'))

  const daily = workflow('daily').jobs
  assert.equal(daily.full.uses, './.github/workflows/full.yml')
  assert.equal(daily.package.uses, './.github/workflows/package.yml')

  const packageJobs = workflow('package').jobs
  for (const name of ['mac', 'windows']) assert.ok(commands(packageJobs[name]).includes('npm run test:memory-plugin'))
  const release = workflow('release').jobs
  assert.deepEqual(release.publish.needs, ['package', 'full'])
  assert.equal(release.full.uses, './.github/workflows/full.yml')
  assert.equal(release.package.uses, './.github/workflows/package.yml')
})

test('scope matches both sides of a rename and retains the original watched directory', () => {
  const paths = changedPaths('R100\0plugins/trace/lib/store.ts\0archive/store.ts\0')
  assert.deepEqual(paths, ['plugins/trace/lib/store.ts', 'archive/store.ts'])
  assert.equal(scopeForPaths(paths).memory, true)
  assert.equal(scopeForPaths(['docs/only.md']).memory, false)
  assert.deepEqual(scopeForPaths(['build/memory-embedding/model.onnx']), {
    memory: false, package: true, fallback: false, paths: ['build/memory-embedding/model.onnx'],
  })
})

test('scope handles PRs, main pushes and unreliable comparisons without losing required specialization', () => {
  const base = 'a'.repeat(40), head = 'b'.repeat(40), before = 'c'.repeat(40), after = 'd'.repeat(40)
  const docs = 'M\0docs/only.md\0'
  const pr = scopeForEvent('pull_request', { pull_request: { base: { sha: base }, head: { sha: head } } }, comparison => {
    assert.deepEqual(comparison, { base, head, mergeBase: true })
    return docs
  })
  assert.deepEqual(pr, { memory: false, package: false, fallback: false, paths: ['docs/only.md'] })
  const push = scopeForEvent('push', { before, after }, comparison => {
    assert.deepEqual(comparison, { base: before, head: after, mergeBase: false })
    return 'M\0plugins/trace/lib/store.ts\0'
  })
  assert.equal(push.memory, true)
  const fallback = scopeForEvent('push', { before, after }, () => { throw new Error('missing history') })
  assert.deepEqual(fallback, { memory: true, package: true, fallback: true, paths: [] })
  assert.deepEqual(scopeForEvent('push', {}, () => docs).fallback, true)
  assert.throws(() => scopeForEvent('workflow_dispatch', {}, () => docs), /Unsupported scope event/)
})
