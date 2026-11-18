import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { scratch } from './fixtures/scratch.js'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { MEMORY_FILE_QUESTION_PREFIX, memoryClarificationResult, type MemoryCompute } from '../src/memory/contracts/memory-contract.ts'
import type { MemoryFileDetail, MemoryFileListResult, MemoryFileMutationResult } from '../src/memory/contracts/file-management.ts'
import type { HostMemoryApi } from '../src/memory/contracts/host.ts'

const disputed = 'Conference venue: old hall; possible new venue: auditorium. Unrelated tea serves Monday.'
const topic = 'Conference venue'

async function setup(t: TestContext) {
  const { dir, defer } = scratch(t, 'memory-file-clarification-')
  const options = { root: dir, hostNamespace: 'viva-test', dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => ({ provider: 'fake', model: 'fake' }), quiesce: async () => {},
    async compute(job: MemoryCompute) {
      if (job.stage === 'note') return JSON.stringify({ status: 'write', title: 'Conference and tea', markdown: disputed })
      if (job.stage === 'question') return JSON.stringify({ snapshotId: (JSON.parse(job.input) as { snapshotId: string }).snapshotId, verdict: 'unrelated' })
      return '{"proposals":[]}'
    },
  }
  let owner = openMemoryOwner(options)
  defer(() => owner.close())
  await owner.recover()
  const author = randomUUID(), original = randomUUID(), at = Date.now()
  await owner.receiveSource({ sessionId: author, messageId: original, text: disputed, at, timezone: 'UTC', turn: 1, step: 1, admitted: true, inherited: false })
  await owner.completeTurn({ sessionId: author, turn: 1, eventSeq: 3, sourceIds: [original], assistant: '', completed: true, at, timezone: 'UTC' })
  await owner.runtime.wake()
  const store = openMemoryStore(join(dir, 'memory.db'))
  defer(() => store.close())
  const documents = openMemoryDocuments({ db: store.db, root: store.fileRoot, source(id) {
    const row = store.readSource(id)
    return row?.text ? { text: row.text, token: memorySourceToken(row), workspace: memorySourceWorkspace(row) } : undefined
  } })
  const list = await owner.handleHost('listFiles', { args: [{ kind: 'daily' }] }) as MemoryFileListResult
  const file = await owner.handleHost('readFile', { args: [list.items[0]!.identity] }) as MemoryFileDetail
  assert.ok(file)
  const source = store.readSource(original)!, workspace = file.identity.workspace, workId = `dream:${randomUUID()}`
  documents.defer({ operationId: workId, workspace, unit: { name: topic, bucket: 'personal', summary: 'Confirm the planned conference venue', paths: [file.path] },
    reason: 'The old hall and auditorium may refer to different plans.', sources: [{ id: source.id, token: memorySourceToken(source) }], reads: [], readPolicies: [],
    files: [{ path: file.path, revision: file.version.contentRevision, policyToken: file.version.policyToken }],
  })
  async function newReader() {
    const reader = randomUUID()
    await owner.receiveSource({ sessionId: reader, messageId: randomUUID(), text: 'Please help with the conference venue.', at, timezone: 'UTC',
      turn: 1, step: 1, admitted: true, inherited: false })
    return reader
  }
  function recall(session: string, query: string) {
    return JSON.parse(owner.runtime.handle({ op: 'recall', session, query }, owner.sessionContext(session))) as {
      notes: Array<{ pendingClarification?: boolean; markdown?: string }>, clarification?: { ref: string },
    }
  }
  function issue(session: string, ref: string) {
    return memoryClarificationResult.parse(JSON.parse(owner.runtime.handle({ op: 'clarify', session, ref }, owner.sessionContext(session))))
  }
  return { get owner() { return owner }, store, documents, file, workspace, workId, author, original, newReader, recall, issue,
    async reopen() { await owner.close(); owner = openMemoryOwner(options); await owner.recover() },
  }
}

const answerInput = (session: string, question: { id: string; question: string }, text: string) => ({ operationId: randomUUID(), session, conversation: session,
  text, question: question.question, requestId: 'the-window-card', questionId: question.id, context: { kind: 'user' },
})

for (const previous of ['pending', 'shown', 'answered'] as const) {
  test(`upgrading retires a ${previous} Dream clarification without blocking direct foreground questions`, async t => {
    const f = await setup(t), reader = await f.newReader()
    // Seed the pre-upgrade state through the legacy receipt APIs, including a live card where applicable.
    const oldQuestion = MEMORY_FILE_QUESTION_PREFIX + randomUUID()
    if (previous !== 'pending') f.store.db.prepare('INSERT INTO memory_session_file_clarifications VALUES (?,?)').run(reader, JSON.stringify([f.workspace, f.workId]))
    if (previous === 'answered') seedAnswer(f, reader, f.workId, 1, oldQuestion)
    const answer = f.documents.deferred(f.workspace, f.workId)?.answer
    await f.reopen()
    assert.deepEqual(f.documents.pending(f.workspace), [])
    assert.equal(f.store.db.prepare('SELECT state FROM memory_document_deferred WHERE operation=?').get(f.workId)?.state, 'expired')
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_session_file_clarifications').get()?.n, 0)
    const session = await f.newReader()
    const result = f.recall(session, topic)
    assert.equal(result.clarification, undefined)
    assert.ok(result.notes.every(hit => !hit.pendingClarification))
    assert.equal(f.issue(reader, randomUUID()).status, 'rejected')
    assert.equal(await f.owner.handleHost('clarificationQuestion', { args: [reader, '1', oldQuestion, 'check'] }), null)
    await assert.rejects(f.owner.handleHost('acceptQuestionAnswer', answerInput(reader, { id: oldQuestion, question: topic }, 'Late reply')), /no longer authorized/)
    if (answer) assert.equal(f.store.readSource(answer.source.id)?.text, 'The conference venue is the library.')
    const front = await f.owner.runtime.authorizeGeneralQuestion({ ...f.owner.sessionContext(session), session, turn: '1' },
      [{ question: 'Which venue should I book for your current request?', options: [] }])
    assert.ok(front)
  })
}

// Reproduce an answer recorded by an older owner, without giving the live model a way to reopen a question.
function seedAnswer(f: Awaited<ReturnType<typeof setup>>, reader: string, workId: string, step: number,
  questionId = MEMORY_FILE_QUESTION_PREFIX + randomUUID()) {
  const reply = step === 1 ? 'The conference venue is the library.' : 'The second conference is in the annex.'
  const id = questionId.slice(MEMORY_FILE_QUESTION_PREFIX.length)
  f.owner.runtime.accept(reply, f.owner.sessionContext(reader), id, { question: 'Which Conference venue?', questionId, requestId: workId, custom: true })
  const source = f.store.readSource(id)!
  f.documents.answer({ operationId: id, workspace: f.workspace, deferredId: workId, source: { id, token: memorySourceToken(source) }, text: reply })
  f.store.outcome(id, 'document-clarification')
  f.store.db.prepare('INSERT INTO owner_occurrences(session,message,source,conversation,admitted) VALUES(?,?,?,?,1)').run(reader, id, id, reader)
  f.owner.dispatch.recordSource(reader, id)
  return { reply, answerId: id }
}
async function resolveVenue(f: Awaited<ReturnType<typeof setup>>, reader: string, workId = f.workId, step = 1) {
  const { reply, answerId } = seedAnswer(f, reader, workId, step)
  const evidence = f.documents.deferred(f.workspace, workId)?.answer?.source
  assert.ok(evidence)
  f.documents.commit({ operationId: workId, workspace: f.workspace, path: step === 1 ? 'digest/wiki/resolved-venue.md' : 'digest/wiki/second-venue.md', expectedRevision: null,
    action: 'CREATE', markdown: reply, sources: [evidence], reads: [] })
  f.documents.resolve(f.workspace, workId)
  assert.equal(f.documents.deferred(f.workspace, workId), null)
  return { reply, answerId }
}

for (const withdrawal of ['forget-file', 'withdraw-chat-source'] as const) {
  test(`resolved answers follow the deletion scope after owner restart on ${withdrawal}`, async t => {
    const f = await setup(t), reader = await f.newReader()
    const { answerId, reply } = await resolveVenue(f, reader)
    await f.reopen()
    const history = { segmentId: reader, role: 'user' as const, sourceId: answerId, text: reply }
    assert.equal(f.owner.runtime.allowedHistory(history), true)
    const operationId = randomUUID()
    if (withdrawal === 'forget-file') {
      await f.owner.handleHost('forgetFile', { args: [{ operationId, identity: f.file.identity, version: f.file.version }] })
      await f.reopen()
      assert.equal(f.owner.runtime.readFile(f.file.identity), null)
      assert.equal(f.owner.runtime.allowedHistory(history), true)
      assert.equal(f.store.readSource(answerId)?.text, reply)
      assert.ok(f.documents.read(f.workspace, 'digest/wiki/resolved-venue.md'))
      assert.deepEqual(await f.owner.handleHost('pendingHostEffects', {}), [])
      return
    } else {
      const { ticket } = await f.owner.handleHost('prepareSourceChange', { operationId, conversation: f.author, ids: [f.original], onlySources: true }) as { ticket: string }
      await f.owner.handleHost('commitSourceChange', { operationId, ticket })
    }
    assert.equal(f.owner.runtime.allowedHistory(history), false)
    const stored = f.store.readSource(answerId)
    assert.equal(stored?.text?.trim(), '')
    assert.equal(stored.question, null)
    assert.equal(f.documents.read(f.workspace, 'digest/wiki/resolved-venue.md'), null)
    const effects = await f.owner.handleHost('pendingHostEffects', {}) as HostMemoryApi['pendingHostEffects']['output']
    const effect = effects.find(item => item.causeOperationId === operationId)
    assert.equal(effect?.kind, 'erase-file-copies')
    assert.deepEqual(effect.ranges?.find(range => range.sourceId === answerId)?.spans, [{ start: 0, end: reply.length }])
    assert.ok(effect.sessions?.includes(reader))
    assert.doesNotMatch(JSON.stringify(effect), /library|old hall|Conference venue/)
    await f.reopen()
    assert.equal(f.owner.runtime.allowedHistory(history), false)
    assert.equal(f.store.readSource(answerId)?.question, null)
  })
}

test('withdrawing an independently proven, disjoint source range preserves the answer', async t => {
  const f = await setup(t), reader = await f.newReader()
  const work = f.documents.deferred(f.workspace, f.workId)!
  const start = disputed.indexOf('Unrelated tea')
  const [source] = work.sources
  f.documents.expire(f.workspace, f.workId)
  const { answer: _answer, status: _status, ...data } = work
  const workId = `dream:${randomUUID()}`
  f.documents.defer({ ...data, operationId: workId, sources: [{ ...source!, spans: [{ start: 0, end: start }] }] })
  const independent = f.documents.commit({ operationId: randomUUID(), workspace: f.workspace, path: 'digest/wiki/tea.md',
    expectedRevision: null, action: 'CREATE', markdown: disputed.slice(start), sources: [{ ...source!, spans: [{ start, end: disputed.length }] }], reads: [] })
  const file = await f.owner.handleHost('readFile', { args: [{ kind: 'digest', workspace: f.workspace, id: independent.documentId }] }) as MemoryFileDetail
  const { answerId, reply } = await resolveVenue(f, reader, workId)
  await f.owner.handleHost('setFileEnabled', { args: [{ operationId: randomUUID(), identity: file.identity, version: file.version, enabled: false }] })
  assert.equal(f.store.readSource(answerId)?.text, reply)
  assert.equal(f.owner.runtime.allowedHistory({ segmentId: reader, role: 'user', sourceId: answerId, text: reply }), true)
  const stopped = await f.owner.handleHost('readFile', { args: [file.identity] }) as MemoryFileDetail
  await f.owner.handleHost('setFileEnabled', { args: [{ operationId: randomUUID(), identity: stopped.identity, version: stopped.version, enabled: true }] })
  const restored = await f.owner.handleHost('readFile', { args: [file.identity] }) as MemoryFileDetail
  await f.owner.handleHost('forgetFile', { args: [{ operationId: randomUUID(), identity: restored.identity, version: restored.version }] })
  assert.equal(f.store.readSource(answerId)?.text, reply)
  assert.equal(f.owner.runtime.allowedHistory({ segmentId: reader, role: 'user', sourceId: answerId, text: reply }), true)
  assert.ok(f.documents.read(f.workspace, 'digest/wiki/resolved-venue.md'))
})

test('stopping selected evidence hides direct and transitive answers and restoring it reopens their evidence', async t => {
  const f = await setup(t), firstReader = await f.newReader()
  const originalWork = f.documents.deferred(f.workspace, f.workId)!
  const first = await resolveVenue(f, firstReader)
  const firstSource = f.store.readSource(first.answerId)!
  const secondId = `dream:${randomUUID()}`
  const { status: _status, answer: _answer, ...data } = originalWork
  f.documents.defer({ ...data, operationId: secondId, sources: [{ id: first.answerId, token: memorySourceToken(firstSource) }] })
  const secondReader = await f.newReader()
  const second = await resolveVenue(f, secondReader, secondId, 2)
  const stop = await f.owner.handleHost('setFileEnabled', { args: [{ operationId: randomUUID(), identity: f.file.identity, version: f.file.version, enabled: false }] }) as { restrictionId: string }
  const history = (reader: string, answer: typeof first) => ({ segmentId: reader, role: 'user' as const, sourceId: answer.answerId, text: answer.reply })
  for (const [reader, answer] of [[firstReader, first], [secondReader, second]] as const) {
    assert.equal(f.owner.runtime.allowedHistory(history(reader, answer)), false)
    assert.equal(f.owner.runtime.dispatchSourceCurrent(answer.answerId), false)
    assert.equal(f.store.readSource(answer.answerId)?.text, answer.reply)
    assert.throws(() => f.owner.acquireSend(randomUUID(), { session: reader }, 'Previously seen clarification answer'))
  }
  const futureReader = await f.newReader()
  assert.doesNotMatch(JSON.stringify(f.recall(futureReader, 'conference')), /library|annex/)
  const managed = await f.owner.handleHost('listFiles', { args: [{ kind: 'digest' }] }) as MemoryFileListResult
  assert.equal(managed.items.length, 2, 'the trusted file manager can still reach the dependent records')
  for (const item of managed.items) {
    const reader = await f.newReader()
    const packet = f.owner.runtime.handle({ op: 'file_read', session: reader, id: item.identity.id, evidence: true }, f.owner.sessionContext(reader))
    assert.deepEqual(JSON.parse(packet), { status: 'unavailable' })
  }
  await f.reopen()
  assert.equal(f.owner.runtime.dispatchSourceCurrent(first.answerId), false)
  assert.equal(f.owner.runtime.dispatchSourceCurrent(second.answerId), false)
  const stopped = await f.owner.handleHost('readFile', { args: [f.file.identity] }) as MemoryFileDetail
  const restriction = stopped.restrictions!.find(item => item.id === stop.restrictionId)!
  assert.ok(restriction)
  await f.owner.handleHost('setFileEnabled', { args: [{ operationId: randomUUID(), identity: stopped.identity, version: restriction.version,
    enabled: true, restrictionId: restriction.id }] })
  assert.equal(f.owner.runtime.allowedHistory(history(firstReader, first)), true)
  assert.equal(f.owner.runtime.allowedHistory(history(secondReader, second)), true)
  assert.equal(f.owner.runtime.readDocument!(f.workspace, 'digest/wiki/resolved-venue.md')?.markdown, first.reply)
  assert.equal(f.owner.runtime.readDocument!(f.workspace, 'digest/wiki/second-venue.md')?.markdown, second.reply)
})

test('a user can erase a derived digest while its clarification parent is temporarily stopped', async t => {
  const f = await setup(t), reader = await f.newReader()
  const { answerId } = await resolveVenue(f, reader)
  const stop = await f.owner.handleHost('setFileEnabled', { args: [{ operationId: randomUUID(), identity: f.file.identity, version: f.file.version, enabled: false }] }) as { restrictionId: string }
  const list = await f.owner.handleHost('listFiles', { args: [{ kind: 'digest' }] }) as MemoryFileListResult
  const digest = await f.owner.handleHost('readFile', { args: [list.items[0]!.identity] }) as MemoryFileDetail
  assert.ok(digest)
  assert.equal(f.owner.runtime.dispatchSourceCurrent(answerId), false)
  const erased = await f.owner.handleHost('forgetFile', { args: [{ operationId: randomUUID(), identity: digest.identity, version: digest.version }] }) as { action: string }
  assert.equal(erased.action, 'FORGET')
  assert.equal(f.store.readSource(answerId)?.text, 'The conference venue is the library.')
  assert.match(f.store.readSource(answerId)?.question ?? '', /Conference venue/)
  const stopped = await f.owner.handleHost('readFile', { args: [f.file.identity] }) as MemoryFileDetail
  assert.ok(stopped.restrictions?.some(item => item.id === stop.restrictionId))
})


test('manual revisions copied from a clarified answer remain tied to its original evidence', async t => {
  const f = await setup(t), reader = await f.newReader()
  const { answerId, reply } = await resolveVenue(f, reader)
  const before = await f.owner.handleHost('listFiles', { args: [{ kind: 'digest' }] }) as MemoryFileListResult
  const digest = before.items.find(item => item.path === 'digest/wiki/resolved-venue.md')
  assert.ok(digest)
  const written = randomUUID()
  const edit = await f.owner.handleHost('editFile', { args: [{
    operationId: written, identity: digest.identity, version: digest.version, text: `${reply}
Use the accessible entrance.`,
  }] }) as MemoryFileMutationResult
  assert.equal(edit.action, 'EDIT')
  const independent = randomUUID()
  const created = await f.owner.handleHost('createFile', { args: [{
    operationId: independent, text: reply,
  }] }) as MemoryFileMutationResult
  assert.deepEqual(f.store.manualFileParents(written).map(parent => parent.id), [answerId])
  assert.match(f.store.readSource(written)?.text ?? '', /library/)
  await f.reopen()
  const current = await f.owner.handleHost('readFile', { args: [f.file.identity] }) as MemoryFileDetail
  const operationId = randomUUID()
  await f.owner.handleHost('forgetFile', { args: [{ operationId, identity: f.file.identity, version: current.version }] })
  assert.equal(f.store.readSource(written)?.erasure ?? null, null)
  assert.match(f.store.readSource(written)?.text ?? '', /accessible entrance/)
  assert.ok(await f.owner.handleHost('readFile', { args: [digest.identity] }))
  const kept = await f.owner.handleHost('readFile', { args: [created.identity] }) as MemoryFileDetail
  assert.match(kept.markdown, /library/)
  assert.equal(f.store.readSource(independent)?.text, reply)
})
