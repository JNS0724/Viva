import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import type { MemoryFileMutationResult } from '../src/memory/contracts/file-management.ts'
import { failureDiagnostics } from './smoke/diagnostics.ts'
import { createOwnedProfile, disposeOwnedProfile } from './smoke/owned-profile.ts'

for (const initialized of [false, true]) test(`smoke diagnostics ${initialized ? 'report current file-owner receipts without bodies' : 'leave an unopened memory root untouched'}`, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-smoke-diagnostics-'))
  const profile = createOwnedProfile(base, 'file-memory')
  t.after(() => { disposeOwnedProfile(profile); fs.rmSync(base, { recursive: true, force: true }) })
  const root = path.join(profile.userData, 'memory'), operation = randomUUID()
  if (initialized) {
    const owner = openMemoryOwner({ root, hostNamespace: 'viva', compute: () => null, route: () => null })
    try {
      await owner.recover()
      const created = await owner.handleHost('createFile', { args: [{ operationId: operation, title: 'Private synthetic title',
        text: 'Private synthetic memory body.' }] }) as MemoryFileMutationResult
      assert.ok(created.identity.id)
    } finally { await owner.close() }
  }
  const output = path.join(profile.root, 'diagnostics')
  const files = await failureDiagnostics(null, profile, output)
  const report = JSON.parse(fs.readFileSync(path.join(output, 'diagnostics.json'), 'utf8')) as { errors: string[] }
  assert.deepEqual(report.errors, [])
  const snapshot = path.join(output, 'memory-state.json')
  assert.equal(files.includes(snapshot), initialized)
  if (!initialized) {
    assert.equal(fs.existsSync(root), false)
    return
  }
  const text = fs.readFileSync(snapshot, 'utf8')
  const memory = JSON.parse(text) as { tableCounts: Record<string, number>, operations: Array<{ id: string, state: string }> }
  assert.ok(memory.tableCounts.memory_sources! > 0)
  assert.ok(memory.tableCounts.memory_documents! > 0)
  assert.ok(memory.operations.some(item => item.id === operation && item.state === 'completed'))
  assert.doesNotMatch(text, /Private synthetic|memory_session_dependencies|memory_links/)
})
