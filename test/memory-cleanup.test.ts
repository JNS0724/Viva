import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createEffects, RETRY_MS } from '../src/backend/effects.ts'
import { createMemoryCleanup, MEMORY_CLEANUP } from '../src/backend/memory-cleanup.ts'
import { MEMORY_EMBEDDING_DIMENSIONS } from '../src/backend/memory-embedder.ts'
import { openMemoryIndex } from '../src/backend/memory-index.ts'
import { memorySemanticCopiesCleared, openMemorySemanticIndex } from '../src/backend/memory-semantic.ts'
import { memoryHash, openMemoryStore } from '../src/backend/memory-store.ts'
import type { MemorySource } from '../src/backend/memory-store.ts'
import { scratch } from './fixtures/scratch.js'

const vector = new Float32Array(MEMORY_EMBEDDING_DIMENSIONS)
vector[0] = 1
const scope = { kind: 'user' } as const
const interval = { from: null, to: null }

test('a pinned WAL snapshot delays verified cleanup, including across a restart', async t => {
  const { dir, defer } = scratch(t, 'viva-memory-cleanup-')
  const file = path.join(dir, 'memory.db')
  const key = randomUUID()
  const deleted = 'redactmarker-viva-cleanup-9f3a31'
  const retained = 'surviving standalone evidence'
  let now = 1
  let cleared = 0

  function open() {
    const store = openMemoryStore(file)
    const effects = createEffects({ db: store.db, now: () => now, later: () => 1, cancel: () => {} })
    const lexical = openMemoryIndex(store.db)
    const semantic = openMemorySemanticIndex(store.db)!
    const cleanup = createMemoryCleanup({ db: store.db, effects, lexical, hasCandidateReference: store.hasCandidateReference,
      clearSemantic: (ids, revision) => semantic.purge(ids, revision), onCleared: () => { cleared++ } })
    const close = () => { effects.close(); store.close() }
    return { store, effects, lexical, semantic, cleanup, close }
  }

  const first = open()
  defer(() => { if (first.store.db.isOpen) first.close() })
  const { store, effects, lexical, semantic, cleanup } = first
  const sourceText = `${deleted} ${retained}`
  const source: MemorySource = { id: randomUUID(), operation: randomUUID(), version: 1, conversation: null, session: null,
    scope, context: null, project: null, author: 'user', text: sourceText, length: sourceText.length, hash: memoryHash(sourceText),
    question: deleted, questionId: null, requestId: null, at: now, timezone: 'UTC', withdrawn: false, outcome: 'accepted' }
  store.insertSource(source)
  const create = (text: string, start: number) => {
    const revision = store.nextRevision()
    const id = store.insert({ text, scope, kind: 'fact', modality: 'asserted', conditional: false, keywords: [],
      source: 'user', conversationId: null }, revision, now, interval)
    const end = start + text.length
    store.evidence(id, source, start, end, null, null, interval, [{ start, end }])
    return { id, revision }
  }
  const remove = create(deleted, 0)
  const keep = create(retained, deleted.length + 1)
  assert.equal(lexical.refresh(), true)
  assert.equal(semantic.configure('embedder'), true)
  assert.equal(semantic.put('embedder', [{ ...remove, vector }, { ...keep, vector }], semantic.version('embedder')!), 2)
  // Reproduce a damaged connection where automatic vector invalidation was unavailable.
  store.db.exec('DROP TRIGGER temp.memory_semantic_invalidate_delete')

  const reader = new DatabaseSync(file, { readOnly: true })
  defer(() => { if (reader.isOpen) reader.close() })
  reader.exec('BEGIN')
  assert.equal(reader.prepare('SELECT text FROM memories WHERE id=?').get(remove.id)?.text, deleted)
  store.tx(() => {
    const revision = store.nextRevision()
    store.remove(remove.id)
    store.redactSource(source.id, ' '.repeat(deleted.length + 1) + retained)
    cleanup.queue(key, remove.id, [remove.id], revision, [{ sourceId: source.id, spans: [{ start: 0, end: deleted.length }] }])
  })
  assert.deepEqual(cleanup.attempt(key), { status: 'stopped' })
  assert.equal(cleanup.pending(), 1)
  await effects.wake()
  assert.ok(effects.get(MEMORY_CLEANUP, key)?.attempts)
  assert.equal(cleared, 0)
  assert.equal(reader.prepare('SELECT text FROM memories WHERE id=?').get(remove.id)?.text, deleted)
  assert.equal(store.get(remove.id), null)
  assert.equal(store.db.prepare('SELECT 1 FROM memory_lexical_fts WHERE rowid=?').get(remove.id), undefined)
  assert.equal(store.db.prepare('SELECT 1 FROM memory_semantic_vectors WHERE memory=?').get(remove.id), undefined)
  first.close()
  reader.close()

  now += RETRY_MS[0]
  const reopened = open()
  defer(reopened.close)
  assert.deepEqual(reopened.cleanup.status(key), { status: 'stopped' })
  await reopened.effects.wake()
  assert.deepEqual(reopened.cleanup.status(key), { status: 'cleared' })
  assert.deepEqual(reopened.cleanup.attempt(key), { status: 'cleared' })
  assert.equal(reopened.cleanup.pending(), 0)
  assert.equal(cleared, 1)
  assert.deepEqual(reopened.lexical.search(retained, scope, 5)?.hits, [keep])
  assert.equal(reopened.store.get(keep.id)?.evidence[0]?.sourceId, source.id)
  assert.equal(reopened.store.db.prepare('SELECT memory FROM memory_semantic_vectors WHERE memory=?').get(keep.id)?.memory, keep.id)
  for (const name of [file, `${file}-wal`]) assert.equal(fs.readFileSync(name).includes(deleted), false, name)
})

test('cleanup fails closed if canonical evidence remains or the requested receipt is missing', async t => {
  const store = openMemoryStore(':memory:')
  const { db } = store
  const effects = createEffects({ db, later: () => 1, cancel: () => {} })
  t.after(() => { effects.close(); store.close() })
  const key = randomUUID()
  const cleanup = createMemoryCleanup({ db, effects, lexical: openMemoryIndex(db), hasCandidateReference: store.hasCandidateReference,
    clearSemantic: (ids, revision) => memorySemanticCopiesCleared(db, ids, revision) })
  assert.deepEqual(cleanup.status(key), { status: 'stopped' })
  const revision = store.nextRevision()
  const id = store.insert({ text: 'retained body', scope, kind: 'fact', modality: 'asserted', conditional: false,
    keywords: [], source: 'user', conversationId: null }, revision, 1, interval)
  cleanup.queue(key, id, [id], revision)
  assert.deepEqual(cleanup.attempt(key), { status: 'stopped' })
  await effects.wake()
  assert.equal(cleanup.pending(), 1)
  assert.ok(store.get(id))

  effects.cancel(MEMORY_CLEANUP, key)
  assert.deepEqual(cleanup.attempt(key), { status: 'stopped' })
  assert.equal(cleanup.pending(), 1)
})
