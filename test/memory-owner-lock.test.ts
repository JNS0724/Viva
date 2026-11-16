import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
const fixture = fileURLToPath(new URL('./fixtures/memory-owner-lock.ts', import.meta.url))
test('OS owner lock rejects another process, including a root alias, until process death', { timeout: 15_000 }, async t => {
  const base = mkdtempSync(join(tmpdir(), 'memory-lock-')), root = join(base, 'root'), alias = join(base, 'alias')
  const child = fork(fixture, [root], { execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, silent: true })
  t.after(() => { child.kill(); rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) })
  await once(child, 'message')
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const options = { compute: () => null, route: () => null, quiesce: async () => {} }
  assert.throws(() => openMemoryOwner({ root, ...options }), /active owner/)
  assert.throws(() => openMemoryOwner({ root: alias, ...options }), /active owner/)
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
  const replacement = openMemoryOwner({ root: alias, ...options })
  await replacement.recover(); assert.equal(replacement.ready(), true); await replacement.close()
})
