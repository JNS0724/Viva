import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { ownerClient } from './fixtures/memory-owner-client.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { createMemoryRuntime } from './fixtures/localized-memory-runtime.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { scratch } from './fixtures/scratch.js'

function open(root: string) { return openMemoryOwner({ root, compute: () => null, route: () => null, quiesce: async () => {} }) }

test('Viva client writes through generic commands with durable replay, typed conflicts and complete UI snapshots', async t => {
  const { dir, defer } = scratch(t, 'memory-client-')
  const file = path.join(dir, 'owner')
  let owner = open(file)
  await owner.recover()
  let runtime = owner.runtime
  defer(() => owner.close())
  let client = ownerClient(owner)
  const addId = randomUUID()
  const entry = await client.addMemory('回答先给结论', 'preference', addId)
  assert.ok(entry)
  assert.equal(entry.kind, 'preference')
  assert.equal(entry.source, 'user')
  assert.ok(entry.evidence.length)
  assert.equal((await client.addMemory('回答先给结论', 'preference', addId))?.id, entry.id)
  await assert.rejects(client.addMemory('异文不得重放', 'preference', addId), /重复|不同|标识|操作|conflict/i)
  await runtime.wake()
  await owner.close()
  owner = open(file)
  await owner.recover()
  runtime = owner.runtime
  client = ownerClient(owner)
  assert.equal((await client.addMemory('回答先给结论', 'preference', addId))?.id, entry.id)
  assert.equal(runtime.listMemories().total, 1)
  const editId = randomUUID()
  const updated = await client.editMemory(entry.id, '回答先给结论，再给依据', entry.revision, editId)
  assert.ok(updated)
  assert.equal((await client.editMemory(entry.id, '回答先给结论，再给依据', entry.revision, editId))?.id, updated.id)
  await assert.rejects(client.editMemory(updated.id, '不覆盖新版本', updated.revision + 1), /变化|改变|更新|刷新|revision|refresh/i)
})

test('Viva stop and restore remain reversible, while delete uses erasure and cannot restore', async t => {
  const { dir, defer } = scratch(t, 'memory-client-state-')
  const owner = open(path.join(dir, 'owner'))
  await owner.recover()
  const runtime = owner.runtime
  defer(() => owner.close())
  const client = ownerClient(owner)
  const entry = await client.addMemory('周五提交周报')
  assert.ok(entry)
  const stopId = randomUUID()
  assert.equal(await client.stopMemory(entry.id, entry.revision, stopId), true)
  assert.equal(await client.stopMemory(entry.id, entry.revision, stopId), true)
  assert.equal(runtime.listMemories().total, 0)
  const stopped = runtime.readManagementEntry(entry.id)
  assert.ok(stopped)
  const restored = await client.restoreMemory(stopped.id, stopped.revision)
  assert.ok(restored)
  assert.equal(runtime.listMemories().total, 1)
  const eraseId = randomUUID()
  const deleted = await client.deleteMemory(restored.id, restored.revision, eraseId)
  assert.ok(['cleared', 'stopped'].includes(deleted.status))
  assert.equal(runtime.listMemories().total, 0)
  assert.ok(['cleared', 'stopped'].includes((await client.deleteMemory(restored.id, restored.revision, eraseId)).status))
  const afterDelete = runtime.readManagementEntry(restored.id)
  await assert.rejects(client.restoreMemory(restored.id, afterDelete?.revision ?? restored.revision))
})

test('Viva deletion waits for a real affected dispatch lease inside the command boundary', async t => {
  const { dir, defer } = scratch(t, 'memory-client-lease-')
  const owner = open(path.join(dir, 'owner'))
  await owner.recover()
  const { runtime, dispatch } = owner
  defer(() => owner.close())
  const client = ownerClient(owner)
  const entry = await client.addMemory('我住在深圳')
  assert.ok(entry)
  dispatch.record('foreground', [{ id: entry.id, revision: entry.revision }])
  const admission = dispatch.admission('foreground')
  assert.ok(admission.allowed)
  const permit = owner.acquireSend('physical-send', { session: 'foreground' }, 'payload')
  let completed = false
  const deletion = client.deleteMemory(entry.id, entry.revision).then(result => { completed = true; return result })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(completed, false, 'conflict must reach coordinator, not become a generic failed response')
  permit.settled()
  assert.ok(['cleared', 'stopped'].includes((await deletion).status))
  assert.equal(completed, true)
  assert.equal(runtime.listMemories().total, 0)
})
