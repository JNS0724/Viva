import test from 'node:test'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryRuntime, openMemoryRuntimeResources } from '../src/memory/node/runtime.ts'
import { createMemoryRuntime as createCoreMemoryRuntime } from '../src/memory/core/memory-runtime.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { MemoryDomainError } from '../src/memory/core/presentation.ts'
import { createMemoryReadPolicy } from '../src/memory/core/memory-read-policy.ts'

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-node-runtime-'))
  let runtime: ReturnType<typeof createMemoryRuntime> | undefined
  t.after(() => { runtime?.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const start = (options: Partial<Parameters<typeof createMemoryRuntime>[0]> = {}) => {
    runtime?.close()
    const store = openMemoryStore(path.join(root, 'memory.db'))
    runtime = createMemoryRuntime({ store, compute: () => null, route: () => null, quiesce: async () => {}, changed: () => {}, ...options })
    return { runtime, store }
  }
  return { start }
}

test('ordinary Node assembly preserves manual operations, revisions and erase receipts across restart', async t => {
  const f = fixture(t)
  const { runtime } = f.start()
  const write = randomUUID(), remove = randomUUID()
  const first = runtime.addMemory('I prefer concise weekly summaries.', 'preference', write)
  assert.ok(first)
  const replay = runtime.addMemory('I prefer concise weekly summaries.', 'preference', write)
  assert.equal(replay?.id, first.id)
  assert.equal(runtime.listMemories().total, 1)
  const ref = { id: first.id, revision: first.revision }
  assert.equal(runtime.dependenciesCurrent([ref]), true)
  const removed = await runtime.deleteMemory(ref.id, ref.revision, remove)
  assert.equal(removed.status, 'cleared')
  assert.equal(runtime.dependenciesCurrent([ref]), false)
  const restarted = f.start().runtime
  assert.equal(restarted.listMemories().total, 0)
  assert.equal((await restarted.deleteMemory(ref.id, ref.revision, remove)).status, 'cleared')
})

test('portable runtime reports stable error codes and optional host wording without a locale dependency', t => {
  const f = fixture(t)
  const { runtime } = f.start({ presentation: { text: key => `Host wording: ${key}` } })
  assert.throws(() => runtime.addMemory(''), error => error instanceof MemoryDomainError
    && error.code === 'invalid.text' && error.message === 'Host wording: invalid.text')
  const { runtime: portable } = f.start()
  assert.throws(() => portable.addMemory(''), error => error instanceof MemoryDomainError
    && error.code === 'invalid.text' && error.message === 'Invalid memory text.')
})

test('extracted read policy does not admit held evidence or stale collection revisions', t => {
  const { runtime, store } = fixture(t).start()
  const first = runtime.addMemory('The deployment checklist needs a review.')
  assert.ok(first)
  const blocked = new Set<string>()
  const policy = createMemoryReadPolicy({ store, now: Date.now, timezone: () => 'UTC',
    evidenceBlocked: edge => blocked.has(edge.sourceId), sourceBlocked: source => blocked.has(source.id) })
  const ref = { id: first.id, revision: first.revision, collectionRevision: store.revision() }
  assert.equal(policy.dependenciesCurrent([ref]), true)
  for (const edge of first.evidence) blocked.add(edge.sourceId)
  assert.equal(policy.dependenciesCurrent([ref]), false)
  assert.equal(policy.selection([first], Date.now()).current.length, 0)
  blocked.clear()
  assert.equal(policy.dependenciesCurrent([ref]), true)
  runtime.addMemory('A separate saved preference.')
  assert.equal(policy.dependenciesCurrent([ref]), false)
})


test('core and note orchestration use injected ports without inspecting platform handles', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-core-ports-'))
  const store = openMemoryStore(path.join(root, 'memory.db'))
  const resources = openMemoryRuntimeResources({ store })
  const guarded = new Proxy(store, {
    get(target, key, receiver) {
      if (key === 'db' || key === 'fileRoot') throw new Error('core tried to open platform storage')
      return Reflect.get(target, key, receiver)
    },
  })
  const runtime = createCoreMemoryRuntime({ store: guarded, resources, dailyNotes: { noteInterval: 1 },
    compute: async job => job.stage === 'note' ? JSON.stringify({ status: 'write', title: 'Port test', markdown: 'The user wants concise replies.' }) : JSON.stringify({ units: [] }),
    route: () => ({ provider: 'test', model: 'test' }), quiesce: async () => {}, changed: () => {} })
  t.after(() => { runtime.close(); fs.rmSync(root, { recursive: true, force: true }) })
  runtime.recordSession('session')
  const source = runtime.accept('I want concise replies.', { conversation: 'conversation', session: 'session' }, randomUUID())
  assert.ok(runtime.recordNoteTurn)
  runtime.recordNoteTurn('session', [source.sourceId], 'Understood.')
  await runtime.wake()
  const notes = resources.openNotes(() => true, () => true)
  assert.equal(notes.list('0000-01-01', '9999-12-31').length, 1)
  const saved = runtime.addMemory('I prefer short answers.')
  assert.ok(saved)
  assert.equal(runtime.dependenciesCurrent([{ id: saved.id, revision: saved.revision }]), true)
})
