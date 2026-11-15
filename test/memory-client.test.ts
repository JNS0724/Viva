import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { createVivaMemoryClient } from '../src/backend/memory-client.ts'
import { createMemoryRuntime } from '../src/backend/memory-runtime.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { scratch } from './fixtures/scratch.js'

function open(file: string) {
  return createMemoryRuntime({ store: openMemoryStore(file), compute: () => null, route: () => null,
    changed: () => {}, quiesce: async () => {} })
}

test('Viva client writes through generic commands with durable replay, typed conflicts and complete UI snapshots', async t => {
  const { dir, defer } = scratch(t, 'memory-client-')
  const file = path.join(dir, 'memory.db')
  let runtime = open(file)
  defer(async () => { await runtime.wake(); runtime.close() })
  let client = createVivaMemoryClient(runtime, work => Promise.resolve(work()))
  const addId = randomUUID()
  const entry = await client.addMemory('回答先给结论', 'preference', addId)
  assert.ok(entry)
  assert.equal(entry.kind, 'preference')
  assert.equal(entry.source, 'user')
  assert.ok(entry.evidence.length)
  assert.equal((await client.addMemory('回答先给结论', 'preference', addId))?.id, entry.id)
  await assert.rejects(client.addMemory('异文不得重放', 'preference', addId), /重复|不同|标识|操作/)
  await runtime.wake()
  runtime.close()
  runtime = open(file)
  client = createVivaMemoryClient(runtime, work => Promise.resolve(work()))
  assert.equal((await client.addMemory('回答先给结论', 'preference', addId))?.id, entry.id)
  assert.equal(runtime.listMemories().total, 1)
  const editId = randomUUID()
  const updated = await client.editMemory(entry.id, '回答先给结论，再给依据', entry.revision, editId)
  assert.ok(updated)
  assert.equal((await client.editMemory(entry.id, '回答先给结论，再给依据', entry.revision, editId))?.id, updated.id)
  await assert.rejects(client.editMemory(updated.id, '不覆盖新版本', updated.revision + 1), /变化|改变|更新|刷新/)
})

test('Viva stop and restore remain reversible, while delete uses erasure and cannot restore', async t => {
  const { dir, defer } = scratch(t, 'memory-client-state-')
  const runtime = open(path.join(dir, 'memory.db'))
  defer(async () => { await runtime.wake(); runtime.close() })
  const client = createVivaMemoryClient(runtime, work => Promise.resolve(work()))
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
  const { createMemoryDispatch } = await import('../src/memory/core/memory-dispatch.ts')
  const { createMemoryCoordination } = await import('../src/memory/core/coordination.ts')
  const { dir, defer } = scratch(t, 'memory-client-lease-')
  const store = openMemoryStore(path.join(dir, 'memory.db'))
  const dispatch = createMemoryDispatch(store, items => runtime.dependenciesCurrent(items), id => runtime.dispatchSourceCurrent(id))
  const runtime = createMemoryRuntime({ store, compute: () => null, route: () => null, changed: () => {},
    quiesce: async () => {}, validateDispatch: dispatch.validateCommit })
  defer(async () => { await runtime.wake(); runtime.close() })
  const coordination = createMemoryCoordination({ runtime: () => runtime, dispatch: () => dispatch })
  const client = createVivaMemoryClient(runtime, coordination.mutate)
  const entry = await client.addMemory('我住在深圳')
  assert.ok(entry)
  dispatch.record('foreground', [{ id: entry.id, revision: entry.revision }])
  const admission = dispatch.admission('foreground')
  assert.ok(admission.allowed)
  dispatch.acquireSession('physical-send', 'foreground', admission, () => !runtime.staleSession('foreground'))
  let completed = false
  const deletion = client.deleteMemory(entry.id, entry.revision).then(result => { completed = true; return result })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(completed, false, 'conflict must reach coordinator, not become a generic failed response')
  assert.equal(coordination.busy(), true)
  dispatch.release('physical-send')
  assert.ok(['cleared', 'stopped'].includes((await deletion).status))
  assert.equal(completed, true)
  assert.equal(runtime.listMemories().total, 0)
})
