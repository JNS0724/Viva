import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'

test('benchmark-only pull requests trigger the native diagnostics checks', () => {
  const file = new URL('../.github/workflows/local-diagnostics.yml', import.meta.url)
  const workflow = parse(readFileSync(file, 'utf8')) as { on: { pull_request: { paths: string[] } } }
  const paths = workflow.on.pull_request.paths
  for (const changed of [
    'scripts/benchmark-memory-diagnostics.ts',
    'scripts/benchmark-diagnostic-flows.ts',
    'scripts/diagnostic-performance-budget.ts',
  ]) {
    assert.ok(paths.some(pattern => posix.matchesGlob(changed, pattern)), changed)
  }
})
