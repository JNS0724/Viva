import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { scratch } from './fixtures/scratch.js'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { createQuestionDesk } from '../src/backend/question-channel.ts'
import { registerMemoryTools } from '../plugins/memory/lib/tools.ts'
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
    return JSON.parse(owner.runtime.handle({ op: 'recall', session, query }, owner.recallOrigin(session))) as {
      notes: Array<{ pendingClarification?: boolean; markdown?: string }>, clarification?: { ref: string },
    }
  }
  function issue(session: string, ref: string) {
    return memoryClarificationResult.parse(JSON.parse(owner.runtime.handle({ op: 'clarify', session, ref }, owner.sessionContext(session))))
  }
  function desk(session: string) {
    const events: Array<{ type: string; [field: string]: unknown }> = [], sent: object[] = []
    const questions = createQuestionDesk({ sessionId: () => session, emit: event => events.push(event), send: reply => sent.push(reply),
      conversationContext: id => ({ conversationId: id, sessionId: id }),
      cancelMemoryClarification: (id, questionId) => owner.handleHost('cancelFileClarification', { args: [id, questionId] }),
      memoryClarificationQuestion: (id, questionId, phase) => owner.handleHost('clarificationQuestion', { args: [id, '1', questionId, phase] }) as Promise<HostMemoryApi['clarificationQuestion']['output']>,
      onAnswer: async (entry, [answer]) => {
        if (!answer?.custom) return
        const question = entry.question.questions[0]
        const accepted = await owner.handleHost('acceptQuestionAnswer', answerInput(session,
          { id: question.id, question: entry.sourceQuestion ?? question.question }, answer.custom)) as { sourceId: string }
        return { sourceIds: { [answer.id]: accepted.sourceId } }
      },
    })
    return { questions, events, sent }
  }
  return { get owner() { return owner }, store, documents, file, workspace, workId, author, original, newReader, recall, issue, desk,
    async reopen() { await owner.close(); owner = openMemoryOwner(options); await owner.recover() },
  }
}

const answerInput = (session: string, question: { id: string; question: string }, text: string) => ({ operationId: randomUUID(), session, conversation: session,
  text, question: question.question, requestId: 'the-window-card', questionId: question.id, context: { kind: 'user' },
})

test('only relevant file retrieval issues a scoped clarification and its genuine free text resumes the same work once', async t => {
  const f = await setup(t), reader = await f.newReader(), foreign = await f.newReader()
  const unrelated = f.recall(reader, 'Unrelated tea')
  assert.ok(unrelated.notes.length)
  assert.equal(unrelated.clarification, undefined)
  const paraphrase = f.recall(reader, 'Where will the conference be held?')
  assert.ok(paraphrase.notes.some(hit => hit.pendingClarification))
  const result = f.recall(reader, topic)
  assert.ok(result.clarification)
  assert.deepEqual(Object.keys(result.clarification), ['ref'])
  assert.ok(result.notes.every(note => !('topic' in note)))
  assert.ok(result.notes.some(hit => hit.pendingClarification))
  assert.doesNotMatch(JSON.stringify(result), /old hall|auditorium/)
  const sourceRead = f.owner.runtime.handle({ op: 'file_read', session: reader, id: f.file.identity.id, evidence: true }, f.owner.sessionContext(reader))
  assert.doesNotMatch(sourceRead, /old hall|auditorium/)
  assert.match(sourceRead, /pendingClarification/)
  assert.equal(f.issue(foreign, result.clarification.ref).status, 'rejected')
  const task = { ...f.owner.sessionContext(foreign), context: { kind: 'task' as const, id: foreign } }
  const taskRecall = JSON.parse(f.owner.runtime.handle({ op: 'recall', session: foreign, query: topic }, task)) as { clarification?: unknown }
  assert.equal(taskRecall.clarification, undefined)
  assert.deepEqual(JSON.parse(f.owner.runtime.handle({ op: 'clarify', session: foreign, ref: result.clarification.ref }, task)),
    { status: 'rejected', reason: 'foreground-only' })
  assert.equal(f.owner.runtime.authorizeGeneralQuestion({ ...f.owner.sessionContext(reader), session: reader, turn: '1' },
    [{ question: 'Which conference venue?', options: [] }]), false)
  const unrelatedQuestion = await f.owner.runtime.authorizeGeneralQuestion({ ...f.owner.sessionContext(reader), session: reader, turn: '1' },
    [{ question: 'Do you prefer herbal tea?', options: [] }])
  assert.equal(typeof unrelatedQuestion, 'function')
  const unresolved = f.owner.dispatch.snapshot(reader)
  assert.equal(unresolved.turnOnly, true)
  assert.equal(await f.owner.handleHost('authorizedProvenance', { session: reader, prior: unresolved }), null)
  const question = f.issue(reader, result.clarification.ref)
  assert.equal(question.status, 'ready-file')
  assert.match(question.question.id, /^memory-clarify:file:/)
  assert.deepEqual(question.question.options, [])
  const { questions, events } = f.desk(reader)
  await questions.receive({ type: 'question', id: 'the-window-card', sessionId: reader, questions: [{ ...question.question, question: 'fabricated wording' }] })
  assert.deepEqual(events.map(event => event.type), ['question'])
  assert.doesNotMatch(JSON.stringify(events), /fabricated wording/)
  assert.match(JSON.stringify(events), /Conference venue/)
  const reply = 'The approved venue is the library.'
  assert.equal(await questions.answer('the-window-card', [{ id: question.question.id, selected: [], custom: reply }]), true)
  const answer = await f.owner.handleHost('acceptQuestionAnswer', answerInput(reader, question.question, reply)) as { sourceId: string }
  assert.equal(answer.sourceId, question.question.id.slice(MEMORY_FILE_QUESTION_PREFIX.length))
  assert.deepEqual(await f.owner.acceptFileClarification({ session: reader, contextGeneration: 0, questionId: question.question.id, text: reply, requireShown: false }, () => true), answer,
    'native completion after Viva intake reuses the same source and deferred response')
  await assert.rejects(f.owner.handleHost('acceptQuestionAnswer', answerInput(reader, question.question, 'Conflicting retry.')))
  assert.equal(f.store.readSource(answer.sourceId)?.outcome, 'document-clarification')
  const confirmed = f.owner.dispatch.snapshot(reader)
  assert.equal(confirmed.turnOnly, false)
  assert.ok(confirmed.sources.includes(answer.sourceId))
  assert.deepEqual(await f.owner.handleHost('authorizedProvenance', { session: reader, prior: confirmed }), confirmed)
  assert.equal(f.documents.deferred(f.workspace, f.workId)?.answer?.source.id, answer.sourceId)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_document_answers').get()?.n, 1)
  assert.equal(f.store.db.prepare('SELECT 1 FROM owner_answer_sources WHERE source=?').get(answer.sourceId), undefined)
  await f.reopen()
  assert.equal(f.documents.deferred(f.workspace, f.workId)?.status, 'ready')
  await assert.rejects(f.owner.handleHost('acceptQuestionAnswer', answerInput(reader, question.question, reply)))
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_document_answers').get()?.n, 1)
})

test('an opening report can clarify only a recall bound to a consumed user interjection', async t => {
  const f = await setup(t)
  for (const useOldRef of [true, false]) {
    const session = randomUUID(), source = randomUUID()
    await f.owner.handleHost('sourceAlias', { operationId: source, sourceId: source, session, conversation: session,
      text: 'Which conference venue?', context: { kind: 'user' } })
    const occurrence = { sessionId: session, at: Date.now(), timezone: 'UTC', turn: 1, admitted: true, inherited: false }
    await f.owner.receiveSource({ ...occurrence, step: 1, messageId: randomUUID(), text: 'Derived report', derived: true })
    const old = f.recall(session, topic).clarification
    assert.ok(old)
    await f.owner.receiveSource({ ...occurrence, step: 2, messageId: source, text: 'Which conference venue?' })
    const retrieved = f.recall(session, 'planned conference venue')
    const fresh = retrieved.clarification
    assert.ok(fresh, JSON.stringify({ retrieved, origin: f.owner.recallOrigin(session) }))
    assert.notEqual(old.ref, fresh.ref)
    const issued = f.issue(session, useOldRef ? old.ref : fresh.ref)
    assert.equal(issued.status, 'ready-file')
    const show = (sources: string[]) => f.owner.handleHost('clarificationQuestion', { args: [session, 'host-turn', issued.question.id, 'show', sources] })
    assert.equal(await show([randomUUID()]), null, 'an unrelated source cannot show this card')
    assert.equal(Boolean(await show([source])), !useOldRef, 'the original report recall stays ineligible')
  }
})

test('forgetting the selected evidence invalidates the waiting question and leaves no source from late answers', async t => {
  const f = await setup(t), reader = await f.newReader()
  const ref = f.recall(reader, topic).clarification?.ref
  assert.ok(ref)
  const result = f.issue(reader, ref)
  assert.equal(result.status, 'ready-file')
  const { questions, events, sent } = f.desk(reader)
  await questions.receive({ type: 'question', id: 'the-window-card', sessionId: reader, questions: [result.question] })
  assert.deepEqual(events.map(event => event.type), ['question'])
  await f.owner.handleHost('forgetFile', { args: [{ operationId: randomUUID(), identity: f.file.identity, version: f.file.version }] })
  const reply = 'The library.'
  assert.equal(await questions.answer('the-window-card', [{ id: result.question.id, selected: [], custom: reply }]), false)
  assert.deepEqual(sent, [{ type: 'decline', id: 'the-window-card' }])
  const native = () => f.owner.acceptFileClarification({ session: reader, contextGeneration: 0, questionId: result.question.id, text: reply, requireShown: false }, () => true)
  assert.equal(await native(), null)
  assert.equal(f.store.readSource(result.question.id.slice(MEMORY_FILE_QUESTION_PREFIX.length)), null)
  assert.equal(f.documents.deferred(f.workspace, f.workId), null)
  await f.reopen()
  assert.equal(await native(), null)
  await assert.rejects(f.owner.handleHost('acceptQuestionAnswer', answerInput(reader, result.question, reply)))
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_document_answers').get()?.n, 0)
})

test('trusted native answers recheck cancellation after the physical send fence drains', async t => {
  const f = await setup(t), reader = await f.newReader()
  const match = f.recall(reader, topic).clarification
  assert.ok(match)
  const result = f.issue(reader, match.ref)
  assert.equal(result.status, 'ready-file')
  const permit = f.owner.acquireSend(randomUUID(), { session: reader }, 'Waiting provider request')
  const invalid = new AbortController()
  const native = f.owner.acceptFileClarification({ session: reader, contextGeneration: 0, questionId: result.question.id,
    text: 'Late answer', requireShown: false }, () => !invalid.signal.aborted)
  try {
    if (!permit.signal.aborted) await new Promise<void>(resolve => permit.signal.addEventListener('abort', () => resolve(), { once: true }))
    invalid.abort()
  } finally { permit.settled() }
  assert.equal(await native, null)
  assert.equal(f.store.readSource(result.question.id.slice(MEMORY_FILE_QUESTION_PREFIX.length)), null)
  assert.equal(f.documents.deferred(f.workspace, f.workId)?.status, 'pending_clarification')

  // A reply from the live caller can still complete the exact durable work. It does not need Viva's show handshake.
  assert.deepEqual(await f.owner.acceptFileClarification({ session: reader, contextGeneration: 0, questionId: result.question.id,
    text: 'The correct venue is the library.', requireShown: false }, () => true),
  { sourceId: result.question.id.slice(MEMORY_FILE_QUESTION_PREFIX.length) })
  assert.equal(f.documents.deferred(f.workspace, f.workId)?.status, 'ready')
})

test('stopping the Viva question while its reply drains a send cancels the owner ticket', async t => {
  const f = await setup(t), reader = await f.newReader()
  const ref = f.recall(reader, topic).clarification?.ref
  assert.ok(ref)
  const result = f.issue(reader, ref)
  assert.equal(result.status, 'ready-file')
  const { questions, sent } = f.desk(reader)
  await questions.receive({ type: 'question', id: 'the-window-card', sessionId: reader, questions: [result.question] })
  const permit = f.owner.acquireSend(randomUUID(), { session: reader }, 'Waiting provider request')
  const reply = 'Late answer in the stopped turn'
  const replying = questions.answer('the-window-card', [{ id: result.question.id, selected: [], custom: reply }])
  try {
    if (!permit.signal.aborted) await new Promise<void>(resolve => permit.signal.addEventListener('abort', () => resolve(), { once: true }))
    questions.declineAll()
  } finally { permit.settled() }
  assert.equal(await replying, false)
  assert.deepEqual(sent, [{ type: 'decline', id: 'the-window-card' }])
  assert.equal(f.documents.deferred(f.workspace, f.workId)?.status, 'pending_clarification')
  assert.equal(f.store.readSource(result.question.id.slice(MEMORY_FILE_QUESTION_PREFIX.length)), null)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_document_answers').get()?.n, 0)
  assert.equal(await f.owner.acceptFileClarification({ session: reader, contextGeneration: 0, questionId: result.question.id, text: reply, requireShown: false }, () => true), null)
})

async function resolveVenue(f: Awaited<ReturnType<typeof setup>>, reader: string, workId = f.workId, step = 1) {
  const ref = f.recall(reader, topic).clarification?.ref
  assert.ok(ref)
  const result = f.issue(reader, ref)
  assert.equal(result.status, 'ready-file')
  const reply = step === 1 ? 'The conference venue is the library.' : 'The second conference is in the annex.'
  const answer = await f.owner.acceptFileClarification({ session: reader, contextGeneration: 0, questionId: result.question.id, text: reply, requireShown: false }, () => true)
  assert.ok(answer)
  const evidence = f.documents.deferred(f.workspace, workId)?.answer?.source
  assert.ok(evidence)
  f.documents.commit({ operationId: workId, workspace: f.workspace, path: step === 1 ? 'digest/wiki/resolved-venue.md' : 'digest/wiki/second-venue.md', expectedRevision: null,
    action: 'CREATE', markdown: reply, sources: [evidence], reads: [] })
  f.documents.resolve(f.workspace, workId)
  assert.equal(f.documents.deferred(f.workspace, workId), null)
  // Fast Dream work can consume its payload before the bridge retries the reply.
  const repeat = (text: string) => f.owner.acceptFileClarification({ session: reader, contextGeneration: 0, questionId: result.question.id, text, requireShown: false }, () => true)
  assert.deepEqual(await repeat(reply), answer)
  assert.equal(await repeat('A conflicting retry'), null)
  f.owner.acquireSend(randomUUID(), { session: reader }, 'Continuation after the consumed clarification').settled()
  return { reply, answerId: answer.sourceId }
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

test('current deferred digest participants are withheld across recall, injection, file and node reads and links', async t => {
  const f = await setup(t), reader = await f.newReader()
  const pending = f.documents.deferred(f.workspace, f.workId)!
  const secret = 'The conference venue is old hall.'
  const digest = f.documents.commit({ operationId: randomUUID(), workspace: f.workspace, path: 'digest/wiki/conference-old-hall.md',
    expectedRevision: null, action: 'CREATE', markdown: '---\nname: Conference venue old hall\ndescription: Old hall confirmed\n---\n' + secret, sources: pending.sources, reads: [] })
  const start = disputed.indexOf('Unrelated tea')
  const independentText = 'Conference refreshments are tea on Monday.'
  const independent = f.documents.commit({ operationId: randomUUID(), workspace: f.workspace, path: 'digest/wiki/refreshments.md',
    expectedRevision: null, action: 'CREATE', markdown: `# Conference refreshments\n\n${independentText} [[${digest.path}|old hall]]`,
    sources: [{ ...pending.sources[0]!, spans: [{ start, end: disputed.length }] }], reads: [] })
  const snapshot = await f.owner.handleHost('readFile', { args: [{ kind: 'digest', workspace: f.workspace, id: digest.documentId }] }) as MemoryFileDetail
  const { status: _status, answer: _answer, ...data } = pending
  f.documents.expire(f.workspace, f.workId)
  f.documents.defer({ ...data, operationId: 'dream:' + randomUUID(),
    unit: { ...data.unit, name: 'Conference venue ALBATROSS side room' },
    reads: [{ id: snapshot.identity.id, revision: snapshot.version.contentRevision, usageVersion: snapshot.version.usageVersion }],
    readPolicies: [{ path: snapshot.path, policyToken: snapshot.version.policyToken }] })
  const assertSafe = (packet: string) => assert.doesNotMatch(packet, /old hall|old-hall|auditorium|ALBATROSS/i)
  const recall = f.recall(reader, topic)
  assert.ok(recall.clarification)
  assert.ok(recall.notes.some(hit => hit.pendingClarification))
  assertSafe(JSON.stringify(recall))
  const origin = f.owner.sessionContext(reader)
  const direct = f.owner.runtime.handle({ op: 'file_read', session: reader, id: digest.documentId, evidence: true }, origin)
  assertSafe(direct)
  assert.match(direct, /pendingClarification/)
  const nodes = f.owner.runtime.handle({ op: 'node_search', session: reader, query: 'Conference venue' }, origin)
  assertSafe(nodes)
  assert.match(nodes, /pendingClarification/)
  const independentRecall = f.recall(reader, 'Conference refreshments')
  assertSafe(JSON.stringify(independentRecall))
  assert.ok(independentRecall.notes.some(note => note.markdown?.includes(independentText)))
  assert.equal(independentRecall.clarification, undefined)
  const linkedDirect = f.owner.runtime.handle({ op: 'file_read', session: reader, id: independent.documentId, evidence: true }, origin)
  assertSafe(linkedDirect)
  assert.match(linkedDirect, /Conference refreshments are tea/)
  const context = f.owner.runtime.handle({ op: 'context', session: reader, turn: 1, question: topic }, origin)
  assertSafe(context)
  assert.match(context, /pendingClarification/)
  const sentFiles = f.owner.dispatch.snapshot(reader).files ?? []
  assert.ok(sentFiles.some(file => file.id === independent.documentId))
  assert.ok(sentFiles.every(file => file.id !== digest.documentId && file.id !== f.file.identity.id))
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

test('the executable tool signal cancels an in-flight Viva answer while the send fence drains', async t => {
  const f = await setup(t), reader = await f.newReader()
  const ref = f.recall(reader, topic).clarification?.ref
  assert.ok(ref)
  type FileQuestion = Extract<ReturnType<typeof memoryClarificationResult.parse>, { status: 'ready-file' }>['question']
  type Tool = { name: string; execute(args: { ref: string }, context: { agent: object; signal: AbortSignal }): Promise<unknown> }
  const controller = new AbortController()
  let show!: (question: FileQuestion) => void
  let stop!: (reason: Error) => void
  const shown = new Promise<FileQuestion>(resolve => { show = resolve })
  const pending = new Promise<never>((_, reject) => { stop = reject })
  const agent = { session: { id: reader, header: { origin: 'web' } } }
  const tools = new Map<string, Tool>()
  const context = {
    tools: { register(tool: Tool) { tools.set(tool.name, tool) } },
    userQuestions: { ask({ questions, signal }: { questions: FileQuestion[]; signal: AbortSignal }) {
      show(questions[0]!)
      signal.addEventListener('abort', () => stop(new Error('Native tool stopped')), { once: true })
      return pending
    } },
  }
  registerMemoryTools(context as unknown as Parameters<typeof registerMemoryTools>[0], async input => f.owner.runtime.handle(input, f.owner.sessionContext(reader)),
    async (questionId, text, _agent, signal) => Boolean(await f.owner.acceptFileClarification({ session: reader, contextGeneration: 0, questionId,
      text, requireShown: false }, () => !signal?.aborted)),
    id => f.owner.runtime.cancelFileClarification(reader, id))
  const tool = tools.get('memory_clarify')
  assert.ok(tool)
  const stoppedNative = assert.rejects(tool.execute({ ref }, { agent, signal: controller.signal }), /Native tool stopped/)
  const question = await shown
  assert.match(question.id, /^memory-clarify:file:/)
  const { questions } = f.desk(reader)
  await questions.receive({ type: 'question', id: 'the-window-card', sessionId: reader, questions: [question] })
  const permit = f.owner.acquireSend(randomUUID(), { session: reader }, 'Waiting provider request')
  const replying = questions.answer('the-window-card', [{ id: question.id, selected: [], custom: 'Late genuine reply' }])
  try {
    if (!permit.signal.aborted) await new Promise<void>(resolve => permit.signal.addEventListener('abort', () => resolve(), { once: true }))
    controller.abort()
  } finally { permit.settled() }
  await stoppedNative
  assert.equal(await replying, false)
  assert.equal(f.documents.deferred(f.workspace, f.workId)?.status, 'pending_clarification')
  assert.equal(f.store.readSource(question.id.slice(MEMORY_FILE_QUESTION_PREFIX.length)), null)
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
