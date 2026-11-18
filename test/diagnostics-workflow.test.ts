import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parse } from 'yaml'

test('daily acceptance runs diagnostics on both platforms', () => {
  const workflows = new URL('../.github/workflows/', import.meta.url)
  const diagnostics = parse(readFileSync(new URL('local-diagnostics.yml', workflows), 'utf8'))
  const daily = parse(readFileSync(new URL('daily.yml', workflows), 'utf8'))
  assert.deepEqual(Object.keys(diagnostics.on).sort(), ['workflow_call', 'workflow_dispatch'])
  assert.deepEqual(diagnostics.jobs.faults.strategy.matrix.os, ['macos-latest', 'windows-latest'])
  assert.equal(daily.jobs.diagnostics.uses, './.github/workflows/local-diagnostics.yml')
})
