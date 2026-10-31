import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSmokeHarness } from '../src/main/smoke-entry.ts'

test('ordinary startup never loads a smoke harness, even when an external path is set', async () => {
  assert.equal(await loadSmokeHarness({ enabled: false, codeRoot: '/missing', packaged: true, env: { SMOKE_TEST_ROOT: '/missing-external-harness' } }), null)
})

test('packaged smoke requires an explicit external harness and fails if it is absent', async () => {
  await assert.rejects(loadSmokeHarness({ enabled: true, codeRoot: '/missing', packaged: true, env: {} }), /Packaged smoke requires SMOKE_TEST_ROOT/)
  await assert.rejects(loadSmokeHarness({ enabled: true, codeRoot: '/missing', packaged: true, env: { SMOKE_TEST_ROOT: '/missing-external-harness' } }), /Smoke harness not found/)
})

test('packaged smoke loads the supplied harness from a path with spaces', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva smoke entry '))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
  fs.writeFileSync(path.join(dir, 'entry.js'), 'export const smokeHarness = { async startModel() { return { url: "http://127.0.0.1:1234", requests: [], close: async () => {} } } }')
  const harness = await loadSmokeHarness({ enabled: true, codeRoot: '/missing', packaged: true, env: { SMOKE_TEST_ROOT: dir } })
  assert.equal((await harness?.startModel({ phase: 'memory', fixtures: dir, port: 0 }))?.url, 'http://127.0.0.1:1234')
})
