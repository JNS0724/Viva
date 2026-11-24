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
import { memorySourceWorkspace } from '../src/memory/node/source-identity.ts'

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-node-runtime-'))
  let runtime: ReturnType<typeof createMemoryRuntime> | undefined
  t.after(() => { runtime?.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const start = (options: Partial<Parameters<typeof createMemoryRuntime>[0]> = {}) => {
    runtime?.close()
    const store = openMemoryStore(path.join(root, 'memory.db'))
    runtime = createMemoryRuntime({ store, ...offlineMemorySafety, compute: () => null, route: () => null, changed: () => {}, ...options })
    return { runtime, store }
  }
  return { start }
}

test('ordinary Node assembly preserves file identities and erasure receipts across restart', async t => {
  const f = fixture(t)
  const { runtime, store } = f.start()
  const input = { operationId: randomUUID(), text: 'I prefer concise weekly summaries.' }
  const workspace = runtime.manualFileWorkspace()
  const canonical = randomUUID()
  runtime.accept('A foreground original in the same personal authorization.', { conversation: 'topic', session: 'session' }, canonical)
  assert.equal(memorySourceWorkspace(store.readSource(canonical)!), workspace)
  const project = { kind: 'project' as const, id: 'git-project' }, projectSource = randomUUID()
  runtime.accept('Project-specific original.', { conversation: 'project-topic', session: 'project-session', project }, projectSource)
  assert.equal(memorySourceWorkspace(store.readSource(projectSource)!), runtime.manualFileWorkspace(project))
  const written = await runtime.writeManagedFile(input.operationId, workspace, input, () => {})
  assert.ok(written)
  assert.deepEqual(await runtime.writeManagedFile(input.operationId, workspace, input, () => {}), written)
  const detail = runtime.readFile(written.identity)
  assert.ok(detail)
  assert.ok(detail.markdown.includes(input.text))
  const reader = 'ordinary-node-reader'
  assert.ok(runtime.handle({ op: 'file_read', session: reader, id: written.identity.id }, { session: reader, conversation: null }).includes(input.text))
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
    compute: () => { started(); return result }, changed: () => {} })
  const source = runtime.accept('I keep a garden.', { conversation: 'topic', session: 'session' })
  runtime.recordNoteTurn!('session', [source.sourceId], '')
  const running = runtime.wake()
  await beginning
  runtime.close()
  finish('{"status":"write","title":"Garden","markdown":"I keep a garden."}')
  await running
})

test('a committed write keeps its publication work across restart and retries without rewriting the file', async t => {
  const f = fixture(t)
  let clock = Date.parse('2026-11-19T06:00:00Z')
  const now = () => clock
  const { runtime, store } = f.start({ now })
  const workspace = runtime.manualFileWorkspace()
  const reader = { session: 'publication-reader', conversation: null }
  const recall = (owner: typeof runtime, word: string) => owner.handle({ op: 'recall', session: reader.session, query: word }, reader)
  const unrelated = { operationId: randomUUID(), text: 'keep tangerine receipts searchable' }
  await runtime.writeManagedFile(unrelated.operationId, workspace, unrelated, () => {})
  await runtime.wake()

  const pending = { operationId: randomUUID(), text: 'magenta observations from the archive' }
  store.db.exec(`CREATE TRIGGER reject_publication BEFORE INSERT ON memory_file_index_nodes
    BEGIN SELECT RAISE(ABORT, 'fixture-index-publication-failure'); END`)
  let receipts = 0
  await assert.rejects(runtime.writeManagedFile(pending.operationId, workspace, pending, () => { receipts++ }), /fixture-index-publication-failure/u)
  assert.equal(receipts, 1, 'the owner can durably record its write and invalidations before publication succeeds')
  assert.equal(runtime.listFiles({ kind: 'digest' }).items.length, 2)
  assert.match(recall(runtime, 'tangerine'), /tangerine/u)
  assert.doesNotMatch(recall(runtime, 'magenta'), /magenta/u)
  assert.match(store.db.prepare("SELECT payload FROM effects WHERE kind='memory.file-index-publish'").get()?.payload as string, /"ids"/u)
  store.db.exec('DROP TRIGGER reject_publication')
  clock += 60_000

  const restarted = f.start({ now }).runtime
  assert.match(recall(restarted, 'tangerine'), /tangerine/u, 'existing projections remain readable during recovery')
  await restarted.wake()
  assert.match(recall(restarted, 'magenta'), /magenta/u)
  const replay = await restarted.writeManagedFile(pending.operationId, workspace, undefined, () => { receipts++ })
  assert.equal(receipts, 2)
  assert.ok(replay)
  assert.equal(restarted.listFiles({ kind: 'digest' }).items.length, 2)
})

test('pending Dream computation leaves committed publication and cleanup runnable', async t => {
  const store = openMemoryStore(':memory:')
  const { effects } = openMemoryRuntimeResources({ store })
  let entered!: () => void, release!: () => void, cleaned!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const hold = new Promise<void>(resolve => { release = resolve })
  const completed = new Promise<void>(resolve => { cleaned = resolve })
  t.after(() => { release(); effects.close(); store.close() })
  effects.runs('memory.dream', async () => { entered(); await hold; return new Map([['daily', 'done']]) })
  const order: string[] = []
  for (const kind of ['memory.file-index-publish', 'memory.document-cleanup']) {
    effects.runs(kind, async () => {
      order.push(kind)
      if (kind === 'memory.document-cleanup') cleaned()
      return new Map([['B', 'done']])
    })
  }
  effects.queue('memory.dream', 'daily', null)
  const dream = effects.wake()
  await started
  effects.queue('memory.file-index-publish', 'B', null)
  effects.queue('memory.document-cleanup', 'B', null)
  const writes = effects.wake()
  await completed
  assert.deepEqual(order, ['memory.file-index-publish', 'memory.document-cleanup'])
  release()
  await Promise.all([dream, writes])
  assert.equal(effects.list().length, 0)
})
