import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createAssistantStream, type CommittedOutput } from '../src/backend/assistant-stream.ts'
import { APP_DB_PRAGMAS, transaction } from '../src/backend/app-db.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { createMemoryHostEffects } from '../src/backend/memory-host-effects.ts'
import { createTaskStore, type StoredTask } from '../src/backend/task-store.ts'
import type { HostMemoryApi, HostMemoryCaller } from '../src/memory/contracts/host.ts'
import { memoryErasureEvidence, type MemoryProvenance } from '../src/memory/contracts/provenance.ts'
import type { MemoryHostEffect } from '../src/memory/contracts/service.ts'
import { createNativeOutputAttempts } from '../src/memory/node/native-output-attempts.ts'
import { scratch } from './fixtures/scratch.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const proofOf = (sourceId: string): MemoryProvenance => ({ sources: [sourceId], dependencies: [], turnOnly: false, epoch: 1 })

test('host file erasure retires exact generated copies and task bodies through retry and WAL checkpoint', async t => {
  const { dir } = scratch(t, 'viva-generated-replicas-')
  const file = join(dir, 'app.db'), db = new DatabaseSync(file)
  t.after(() => db.close())
  db.exec(APP_DB_PRAGMAS)
  const history = openHistoryDb({ db }), tasks = createTaskStore({ db, retainedReply: history.retainedReply })
  const source = randomUUID(), original = 'private fragment but independent tail'
  const affected = proofOf(source)
  const surviving = { ...affected, fileSources: [source], files: [{ workspace: '0'.repeat(64), id: 'independent', path: 'digest/wiki/kept.md',
    revision: 'a', usageVersion: 1, policyToken: 'p', sourceRanges: [{ sourceId: source, spans: [{ start: 21, end: 31 }] }] }] }
  const sensitive = 'generated answer from forgotten memory'
  const taskBody = 'task body from forgotten memory'
  const old = { key: 'erased-reply', role: 'assistant', text: sensitive, receipt: null }
  const independent = { key: 'independent-reply', role: 'assistant', text: 'independent answer in the same session', receipt: null }
  const identical = { ...old, key: 'independently-derived-reply' }
  const taskMessage = { key: 'erased-task-input', role: 'user', text: taskBody, receipt: null }
  const taskMeta = (id: string, segmentId: string, requestMemory: MemoryProvenance): StoredTask =>
    ({ id, segmentId, title: id, words: 'independent task metadata', requestMemory })
  const session = randomUUID(), taskSession = randomUUID(), survivorTask = randomUUID(), cleanTask = randomUUID()
  assert.equal(history.bindGeneratedCopy(session, old.key, 'assistant', old.text, [memoryErasureEvidence(affected)]), true)
  assert.equal(history.bindGeneratedCopy(session, independent.key, 'assistant', independent.text, [memoryErasureEvidence(surviving)]), true)
  assert.equal(history.bindGeneratedCopy(session, identical.key, 'assistant', identical.text, [memoryErasureEvidence(surviving)]), true)
  assert.equal(history.bindGeneratedCopy(taskSession, taskMessage.key, 'user', taskMessage.text, [memoryErasureEvidence(affected)]), true)
  const messages = [{ role: 'user', text: original, receipt: null, sourceId: source }, old, independent, identical]
  const before = history.save(history.create({ sessionId: session }), messages)
  const copy = history.save(history.create({ sessionId: randomUUID() }), messages, { copy: { from: before.id, count: messages.length } })
  assert.equal(history.get(copy.id)?.messages[1]?.text, old.text, 'forked replies retain their verified origin session')
  const other = history.save(history.create({ sessionId: randomUUID() }), [{ role: 'user', text: sensitive, receipt: null }])
  const task = history.save(history.create({ sessionId: taskSession }), [taskMessage, { role: 'user', text: 'independent follow-up', receipt: null }])
  const taskFork = history.save(history.create({ sessionId: randomUUID() }), [taskMessage], { copy: { from: task.id, count: 1 } })
  assert.equal(history.get(taskFork.id)?.messages[0]?.text, taskBody)
  tasks.add({ ...taskMeta(taskSession, task.id, affected), words: taskBody })
  for (const id of [survivorTask, cleanTask]) {
    const result = { ...old, key: `preview-${id}` }
    assert.equal(history.bindGeneratedCopy(id, result.key, 'assistant', result.text,
      [memoryErasureEvidence(id === survivorTask ? affected : surviving)]), true)
    const archive = history.save(history.create({ sessionId: id }), [result])
    tasks.add({ ...taskMeta(id, archive.id, surviving), resultKey: result.key, resultPreview: result.text })
  }

  const operation = randomUUID()
  const effect: MemoryHostEffect = { effectId: operation, causeOperationId: operation, revision: 1, hostNamespace: 'viva', kind: 'erase-file-copies',
    sources: [{ namespace: 'canonical', sourceId: source, revision: 1 }], ranges: [
      { sourceId: source, revision: 1, length: original.length, hash: hash(original), afterHash: hash(' '.repeat(16) + original.slice(16)), spans: [{ start: 0, end: 16 }] },
    ] }
  const call: HostMemoryCaller = async method => {
    assert.equal(method, 'pendingHostEffects', 'this local receipt does not acknowledge the entire owner effect')
    return [effect] as HostMemoryApi[typeof method]['output']
  }
  const calls: string[][] = [], receipts: string[] = []
  const removed: string[][] = []
  const host = createMemoryHostEffects({ db, call, apply: (_kind, _data, write) => ({ value: transaction(db, write) }),
    eraseHistory: history.eraseMemoryCopies, eraseFileHistory: history.eraseFileRanges, eraseTaskBodies: tasks.eraseMemoryBodies,
    invalidate() {}, invalidateTaskBodies(ids) { calls.push([...ids].sort()); if (calls.length === 1) throw new Error('task close interrupted') },
    generatedCopiesRemoved(copies) { removed.push(copies.map(copy => copy.key).sort()) },
    fileCopiesDurable(effect) { receipts.push(effect.effectId) } })
  t.after(() => host.close())
  const reader = new DatabaseSync(file, { readOnly: true })
  try {
    reader.exec('BEGIN')
    assert.equal(reader.prepare('SELECT text FROM messages WHERE source_key=?').get(taskMessage.key)?.text, taskBody)
    await assert.rejects(host.recover(), /task close interrupted/)
    await assert.rejects(host.recover(), /durable checkpoint/)
    assert.deepEqual(calls, [[taskSession, survivorTask].sort(), [taskSession, survivorTask].sort()])
    assert.deepEqual(receipts, [])
    assert.equal(readFileSync(file + '-wal').includes(taskBody) || readFileSync(file).includes(taskBody), true)
  } finally { reader.close() }
  await host.recover()
  assert.deepEqual(receipts, [operation])
  assert.equal(calls.length, 2, 'recovering the checkpoint does not close tasks again')
  assert.deepEqual(removed[0], [old.key, taskMessage.key, `preview-${survivorTask}`].sort())
  for (const kept of [before, copy]) {
    assert.deepEqual(history.get(kept.id)?.messages.map(row => row.text), [' '.repeat(16) + original.slice(16), '', independent.text, identical.text])
  }
  assert.equal(history.get(other.id)?.messages[0]?.text, sensitive, 'identical independent text is not inferred as a replica')
  history.save(before, messages)
  history.save(before, [messages[0], { role: 'assistant', text: old.text, receipt: null }, independent, identical])
  history.save(taskFork, [taskMessage])
  history.save(task, [taskMessage, { role: 'user', text: 'independent follow-up', receipt: null }])
  assert.deepEqual(history.get(task.id)?.messages.map(row => row.text), ['', 'independent follow-up'])
  assert.equal(history.get(taskFork.id)?.messages[0]?.text, '', 'a late fork save uses the durable source session')
  assert.equal(history.get(before.id)?.messages[1]?.text, '', 'dropping a stream key does not restore a retired reply')
  assert.throws(() => tasks.add(taskMeta(taskSession, task.id, affected)), /cannot be restored/)
  assert.equal(tasks.list().find(item => item.id === survivorTask)?.resultPreview, '')
  assert.equal(tasks.list().find(item => item.id === cleanTask)?.resultPreview, sensitive)
  const retained = tasks.list().find(item => item.id === survivorTask)!
  tasks.add({ ...retained, resultKey: `preview-${survivorTask}`, resultPreview: sensitive })
  assert.equal(tasks.list().find(item => item.id === survivorTask)?.resultPreview, '', 'a late ending cannot republish the retired preview')
  assert.equal(history.searchMessages(taskBody).length, 0)
  assert.equal(readFileSync(file).includes(taskBody), false)

  const late = { ...old, key: 'late-completed-output' }
  assert.equal(history.bindGeneratedCopy(session, late.key, 'assistant', late.text, [memoryErasureEvidence(affected)]), false)
  history.save(before, [...messages, late])
  assert.equal(history.get(before.id)?.messages.at(-1)?.text, '', 'new proof for an output finishing after the cut is retired on arrival')
})

test('native host evidence requires the exact session and settlement digest across reused positions', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const archive = createNativeOutputAttempts(db), session = randomUUID()
    const one = { id: randomUUID(), session, generation: 0, turn: 1, step: 1, floor: 9 }
    const two = { ...one, id: randomUUID(), generation: 1 }
    const first = proofOf(randomUUID()), subsequent = proofOf(randomUUID())
    archive.record(one, first)
    archive.finish(one, { seq: 9, kind: 'reply', digest: hash('first terminal') })
    archive.record(two, subsequent)
    archive.finish(two, { seq: 9, kind: 'reply', digest: hash('second terminal') })
    assert.deepEqual(archive.outputEvidence(session, 9, hash('first terminal')), [memoryErasureEvidence(first)])
    assert.deepEqual(archive.outputEvidence(session, 9, hash('second terminal')), [memoryErasureEvidence(subsequent)])
    assert.equal(archive.outputEvidence(session, 9, hash('unknown terminal')), null)
    assert.equal(archive.outputEvidence(randomUUID(), 9, hash('first terminal')), null)
  } finally { db.close() }
})

test('authoritative stream completion binds the proof before delivering repaired output', async () => {
  const rows: string[] = [], outputs: CommittedOutput[] = []
  const committed = { key: 'output', native: { seq: 3, digest: hash('terminal') }, blocks: [{ type: 'text' as const, text: 'reply' }] }
  const stream = createAssistantStream({
    send(message) {
      const action = message as { type: string, operation: string, proofs?: boolean }
      if (action.type === 'assistant_stream_bind') {
        assert.equal(action.proofs, true)
        stream.receive({ type: 'assistant_stream_bound', version: 1, operation: action.operation })
      } else {
        stream.receive({ type: 'assistant_stream_flushed', version: 1, operation: action.operation, messages: [committed], finalReply: true })
      }
    },
    async recordOutputs(session, settled) { assert.equal(session, 'session'); outputs.push(...settled); rows.push('proved'); return settled },
    emit() { rows.push('delivered') },
  })
  stream.receive({ type: 'assistant_stream_ready', version: 1 })
  const operation = await stream.begin('session')
  assert.equal(await stream.complete(operation), true)
  assert.deepEqual(outputs, [committed])
  assert.equal(rows[0], 'proved')
  assert.ok(rows.includes('delivered'))
})

test('a late native completion withdraws its rejected active key and does not replay its blocks', async () => {
  const output = { key: 'retired-output', native: { seq: 3, digest: hash('terminal') }, blocks: [{ type: 'text' as const, text: 'erased reply' }] }
  const updates: unknown[] = []
  const stream = createAssistantStream({
    send(message) {
      const action = message as { type: string, operation: string }
      if (action.type === 'assistant_stream_bind') {
        stream.receive({ type: 'assistant_stream_bound', version: 1, operation: action.operation })
      } else {
        stream.receive({ type: 'assistant_stream_flushed', version: 1, operation: action.operation, messages: [output], finalReply: true })
      }
    },
    async recordOutputs() { return [] },
    emit(_session, update) { updates.push(update) },
  })
  stream.receive({ type: 'assistant_stream_ready', version: 1 })
  const operation = await stream.begin('session')
  const event = { type: 'assistant_stream', version: 1, operation: operation.id, sessionId: 'session', key: output.key }
  stream.receive({ ...event, kind: 'start' })
  stream.receive({ ...event, kind: 'delta', index: 0, blockType: 'text', text: 'provisional' })
  stream.receive({ ...event, kind: 'settle', blocks: output.blocks })
  assert.deepEqual(updates, [{ sessionUpdate: 'viva_stream', key: output.key, kind: 'delta', index: 0, blockType: 'text', text: 'provisional' }])
  assert.equal(await stream.complete(operation), false)
  assert.deepEqual(updates.slice(1), [{ sessionUpdate: 'viva_stream', key: output.key, kind: 'settle', blocks: [] }])
})
