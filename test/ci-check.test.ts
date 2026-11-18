import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parse } from 'yaml'
import { changedPaths, scopeForEvent, scopeForPaths } from '../scripts/ci-scope.ts'
import { integrationLanes } from './smoke/suites.ts'

type Step = { run?: string, uses?: string, if?: string, env?: Record<string, string>, with?: Record<string, unknown> }
type Job = {
  if?: string, needs?: string[], uses?: string, 'timeout-minutes'?: number,
  strategy?: { 'fail-fast': boolean, matrix: { os: string[], lane?: string[] } },
  steps?: Step[],
}
const workflow = (name: string) => parse(fs.readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8')) as { jobs: Record<string, Job> }
const { jobs } = workflow('check')
const gate = jobs.check
const script = String(gate.steps!.find(step => step.with?.script)!.with!.script)
const commands = (job: Job) => (job.steps ?? []).flatMap(step => step.run ? [step.run] : [])

test('the real CI gate requires every job and rejects failure, cancellation, skips and missing results', () => {
  const run = (results: Record<string, { result: string }>, scope = { memory: 'true', package: 'true' }) => {
    const failures: string[] = []
    new Function('process', 'core', script)({ env: {
      CHECK_RESULTS: JSON.stringify(results), MEMORY_REQUIRED: scope.memory, PACKAGE_REQUIRED: scope.package,
    } }, { setFailed: (message: string) => failures.push(message) })
    return failures
  }
  const success = Object.fromEntries(gate.needs!.map(name => [name, { result: 'success' }]))
  assert.deepEqual(run(success), [])
  assert.equal(gate.if, 'always()')
  for (const name of gate.needs!) {
    for (const result of ['failure', 'cancelled', 'skipped', 'unknown']) {
      assert.match(run({ ...success, [name]: { result } }).join(), new RegExp(name))
    }
    const missing = { ...success }
    delete missing[name]
    assert.match(run(missing).join(), new RegExp(name))
  }
  assert.deepEqual(run({ ...success, memory: { result: 'skipped' }, package: { result: 'skipped' } }, { memory: 'false', package: 'false' }), [])
  assert.match(run({ ...success, scope: { result: 'failure' } }, { memory: 'false', package: 'false' }).join(), /scope/)
  assert.match(run(success, { memory: 'invalid', package: 'true' }).join(), /invalid-scope/)
  assert.ok(run({}).length)
})

test('CI runs complete headless checks, independent core and every integration lane on both OSes', () => {
  assert.deepEqual(gate.needs, ['headless', 'core', 'integration', 'scope', 'memory', 'package'])
  for (const name of ['headless', 'core', 'integration', 'check']) {
    assert.deepEqual(jobs[name].strategy!.matrix.os, ['macos-latest', 'windows-latest'])
    assert.equal(jobs[name].strategy!['fail-fast'], false)
  }
  assert.deepEqual(jobs.integration.strategy!.matrix.lane, Object.keys(integrationLanes))
  for (const command of ['npm run typecheck', 'npm run test:pr', 'npm run check:i18n']) assert.ok(commands(jobs.headless).includes(command))
  assert.ok(commands(jobs.core).includes('npm run smoke:core'))
  assert.ok(commands(jobs.integration).includes('npx playwright test -c test/smoke/playwright.config.ts --project=integration'))
  for (const name of ['core', 'integration']) assert.ok(commands(jobs[name]).includes('npm run build'))
  assert.equal(jobs.scope.steps![0].with!['fetch-depth'], 0)
  assert.equal(jobs.memory.if, "needs.scope.outputs.memory-required == 'true'")
  assert.equal(jobs.package.if, "needs.scope.outputs.package-required == 'true'")
})

test('full and daily workflows retain diagnostics and package owns offline installation', () => {
  const full = workflow('full').jobs.full
  assert.equal(full['timeout-minutes'], 45)
  for (const command of ['npm run typecheck', 'npm run test:source', 'npm run smoke', 'npm run smoke:perf']) {
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
