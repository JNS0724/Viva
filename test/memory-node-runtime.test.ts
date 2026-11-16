import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryRuntime, openMemoryRuntimeResources } from '../src/memory/node/runtime.ts'
import { createMemoryRuntime as createCoreMemoryRuntime } from '../src/memory/core/memory-runtime.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { MemoryDomainError } from '../src/memory/core/presentation.ts'
import { offlineMemorySafety } from './fixtures/memory-safety.ts'

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-node-runtime-'))
  let runtime: ReturnType<typeof createMemoryRuntime> | undefined
  t.after(() => { runtime?.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const start = (options: Partial<Parameters<typeof createMemoryRuntime>[0]> = {}) => {
    runtime?.close()
    const store = openMemoryStore(path.join(root, 'memory.db'))
    runtime = createMemoryRuntime({ store, ...offlineMemorySafety, compute: () => null, route: () => null,
      quiesce: async () => {}, changed: () => {}, ...options })
    return { runtime, store }
  }
  return { start }
}

test('ordinary Node assembly preserves file identities and erasure receipts across restart', async t => {
  const f = fixture(t)
  const { runtime, store } = f.start()
  const input = { operationId: randomUUID(), text: 'I prefer concise weekly summaries.' }
  const workspace = runtime.manualFileWorkspace()
  const written = await runtime.writeManagedFile(input.operationId, workspace, input, () => {})
  assert.ok(written)
  assert.deepEqual(await runtime.writeManagedFile(input.operationId, workspace, input, () => {}), written)
  const detail = runtime.readFile(written.identity)
  assert.ok(detail)
  assert.ok(detail.markdown.includes(input.text))
  const reader = 'ordinary-node-reader'
  assert.ok(runtime.handle({ op: 'file_read', session: reader, id: written.identity.id }, { session: reader, conversation: null }).includes(input.text))
  assert.equal(store.dispatch.snapshot(reader).files?.[0]?.id, written.identity.id)
  assert.deepEqual(store.dispatch.snapshot(reader).fileSources, detail.sources.map(source => source.sourceId))
  assert.deepEqual(['memories', 'memory_evidence', 'memory_facts', 'memory_links', 'memory_candidates', 'memory_exclusions']
    .flatMap(name => store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").all(name)), [])
  const erase = { operationId: randomUUID(), identity: detail.identity, version: detail.version }
  await runtime.forgetFile(erase, () => {})
  assert.equal(runtime.readFile(written.identity), null)
  const restarted = f.start().runtime
  assert.equal(restarted.readFile(written.identity), null)
  assert.equal(restarted.listFiles({ kind: 'digest' }).items.length, 0)
  assert.deepEqual(await restarted.writeManagedFile(input.operationId, workspace, undefined, () => {}), written)
  assert.equal(restarted.readFile(written.identity), null, 'an old committed write receipt cannot revive its erased file')
})

test('portable file writes report stable domain codes and optional host wording', async t => {
  const f = fixture(t)
  const { runtime } = f.start({ presentation: { text: key => `Host wording ${key}` } })
  await assert.rejects(runtime.writeManagedFile(randomUUID(), runtime.manualFileWorkspace(), { operationId: randomUUID(), text: '' }, () => {}),
    error => error instanceof MemoryDomainError && error.code === 'invalid.text' && error.message === 'Host wording invalid.text')
  const { runtime: portable } = f.start()
  await assert.rejects(portable.writeManagedFile(randomUUID(), portable.manualFileWorkspace(), { operationId: randomUUID(), text: '' }, () => {}),
    error => error instanceof MemoryDomainError && error.code === 'invalid.text' && error.message === 'Invalid memory text.')
})

test('core and note orchestration use explicit safety ports without inspecting platform handles', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-core-ports-'))
  const store = openMemoryStore(path.join(root, 'memory.db'))
  const resources = openMemoryRuntimeResources({ store })
  const guarded = new Proxy(store, {
    get(target, key, receiver) {
      if (key === 'db' || key === 'fileRoot') throw new Error('core tried to open platform storage')
      return Reflect.get(target, key, receiver)
    },
  })
  const runtime = createCoreMemoryRuntime({ store: guarded, resources, ...offlineMemorySafety, dailyNotes: { noteInterval: 1 },
    compute: async job => job.stage === 'note' ? JSON.stringify({ status: 'write', title: 'Port test', markdown: 'The user wants concise replies.' }) : JSON.stringify({ units: [] }),
    route: () => ({ provider: 'test', model: 'test' }), quiesce: async () => {}, changed: () => {} })
  t.after(() => { runtime.close(); fs.rmSync(root, { recursive: true, force: true }) })
  runtime.recordSession('session')
  const source = runtime.accept('I want concise replies.', { conversation: 'conversation', session: 'session' }, randomUUID())
  assert.ok(runtime.recordNoteTurn)
  runtime.recordNoteTurn('session', [source.sourceId], 'Understood.')
  await runtime.wake()
  assert.equal(runtime.listFiles({ kind: 'daily' }).items.length, 1)
  const input = { operationId: randomUUID(), text: 'I prefer short answers.' }
  const saved = await runtime.writeManagedFile(input.operationId, runtime.manualFileWorkspace(), input, () => {})
  assert.ok(saved)
  assert.ok(runtime.readFile(saved.identity)?.markdown.includes(input.text))
})

test('public core rejects missing physical-send safety capabilities before opening file resources', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-required-safety-'))
  const store = openMemoryStore(path.join(root, 'memory.db'))
  const resources = openMemoryRuntimeResources({ store })
  t.after(() => { resources.effects.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }) })
  for (const omitted of ['canCommit', 'validateDispatch', 'runDocumentMutation']) {
    const input = { store, resources, compute: () => null, route: () => null, quiesce: async () => {}, changed: () => {},
      ...offlineMemorySafety } as Record<string, unknown>
    delete input[omitted]
    assert.throws(() => Reflect.apply(createCoreMemoryRuntime, undefined, [input]), /safety ports must be provided/)
  }
})

test('the file-only store rejects the prior schema before creating any new tables', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-prior-schema-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'memory.db')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE old_schema_marker(value TEXT); PRAGMA user_version=6')
  db.close()
  assert.throws(() => openMemoryStore(file), /incompatible contract version/)
  const unchanged = new DatabaseSync(file)
  try {
    assert.equal(unchanged.prepare('PRAGMA user_version').get()?.user_version, 6)
    assert.equal(unchanged.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_sources'").get(), undefined)
  } finally { unchanged.close() }
})

test('closing a runtime retires a late note calculation before it can read closed storage', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-late-note-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let started!: () => void, finish!: (value: string) => void
  const beginning = new Promise<void>(resolve => { started = resolve })
  const result = new Promise<string>(resolve => { finish = resolve })
  const runtime = createMemoryRuntime({ store: openMemoryStore(path.join(root, 'memory.db')), ...offlineMemorySafety,
    dailyNotes: { noteInterval: 1 }, route: () => ({ provider: 'fixture', model: 'fixture' }),
    compute: () => { started(); return result }, quiesce: async () => {}, changed: () => {} })
  const source = runtime.accept('I keep a garden.', { conversation: 'topic', session: 'session' })
  runtime.recordNoteTurn!('session', [source.sourceId], '')
  const running = runtime.wake()
  await beginning
  runtime.close()
  finish('{"status":"write","title":"Garden","markdown":"I keep a garden."}')
  await running
})
