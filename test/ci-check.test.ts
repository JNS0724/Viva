import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parse } from 'yaml'
import { integrationLanes } from './smoke/suites.ts'

type Job = {
  if?: string
  needs?: string[]
  strategy: { 'fail-fast': boolean, matrix: { os: string[], lane?: string[] } }
  steps: { run?: string, with?: { script?: string } }[]
}
const { jobs } = parse(fs.readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8')) as { jobs: Record<string, Job> }
const gate = jobs.check
const script = gate.steps.find(step => step.with?.script)!.with!.script!

test('the real CI gate requires every job and rejects failure, cancellation, skips and missing results', () => {
  const run = (results: Record<string, { result: string }>) => {
    const failures: string[] = []
    new Function('process', 'core', script)({ env: { CHECK_RESULTS: JSON.stringify(results) } }, { setFailed: (message: string) => failures.push(message) })
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
  assert.ok(run({}).length)
})

test('CI runs complete headless checks, independent core and every integration lane on both OSes', () => {
  assert.deepEqual(gate.needs, ['headless', 'core', 'integration'])
  for (const name of [...gate.needs!, 'check']) {
    assert.deepEqual(jobs[name].strategy.matrix.os, ['macos-latest', 'windows-latest'])
    assert.equal(jobs[name].strategy['fail-fast'], false)
  }
  assert.deepEqual(jobs.integration.strategy.matrix.lane, Object.keys(integrationLanes))
  const commands = (name: string) => jobs[name].steps.flatMap(step => step.run ? [step.run] : [])
  for (const command of ['npm run typecheck', 'npm test', 'npm run check:i18n']) assert.ok(commands('headless').includes(command))
  assert.ok(commands('core').includes('npm run smoke:core'))
  assert.ok(commands('integration').includes('npx playwright test -c test/smoke/playwright.config.ts --project=integration'))
  for (const name of ['core', 'integration']) assert.ok(commands(name).includes('npm run build'))
})
