import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { scratch } from './fixtures/scratch.js'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import type { MemoryContextRecoveryTicket } from '../src/memory/contracts/context-recovery.ts'

const options = { dailyNotes: false as const, route: () => null, compute: async () => '{"facts":[]}', quiesce: async () => {} }
async function original(owner: ReturnType<typeof openMemoryOwner>, sessionId: string, text = 'I enjoy peppermint tea.', turn = 1) {
  const messageId = randomUUID()
  await owner.receiveSource({ sessionId, messageId, text, at: Date.now(), timezone: 'UTC', turn, step: 1,
    admitted: true, inherited: false, contextGeneration: owner.contextGeneration(sessionId) })
  return { messageId, content: text }
}
function bind(owner: ReturnType<typeof openMemoryOwner>, ticket: MemoryContextRecoveryTicket) {
  const input = { ticketId: ticket.ticketId, replacementMessageId: randomUUID(), replacementHash: randomUUID() }
  owner.bindContextRecovery(input)
  return { ...input, baseSurfaceHash: ticket.baseSurfaceHash, persisted: true as const }
}
async function aborted(signal: AbortSignal) {
  if (signal.aborted) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('expected abort')), 2000)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

test('context recovery drains physical permits and only replaces readsets after the bound durable acknowledgement', async t => {
  const { dir, defer } = scratch(t, 'memory-context-owner-')
  const owner = openMemoryOwner({ root: dir, ...options }); defer(() => owner.close()); await owner.recover()
  const session = randomUUID(), human = await original(owner, session)
  await owner.registerDerived({ sessionId: session, messageId: 'old-assistant', sourceIds: [human.messageId] })
  const permit = owner.acquireSend('held', { session }, 'old model context')
  try {
    const pending = owner.prepareContextRecovery({ sessionId: session, baseSurfaceHash: 'before', candidates: [human, { messageId: 'old-assistant', content: 'assistant' }] })
    await aborted(permit.signal)
    assert.equal(owner.contextRecovery(session), null)
    permit.settled()
    const ticket = await pending
    assert.deepEqual(ticket.retainedMessageIds, [human.messageId])
    assert.equal(owner.contextGeneration(session), 0)
    assert.throws(() => owner.acquireSend('pending', { session }, 'old'), /generation/)
    const ack = bind(owner, ticket)
    await assert.rejects(owner.commitContextRecovery({ ...ack, replacementHash: 'wrong' }, () => true), /conflicts/)
    await assert.rejects(owner.commitContextRecovery(ack, () => false), /Native context/)
    assert.equal(owner.contextGeneration(session), 0)
    await owner.commitContextRecovery(ack, () => true)
    assert.equal(owner.contextGeneration(session), 1)
    assert.deepEqual(owner.dispatch.snapshot(session).sources, [human.messageId])
    assert.throws(() => owner.acquireSend('old-retry', { session, contextGeneration: 0 }, 'old'), /generation/)
    assert.throws(() => owner.acquireSend('missing-generation', { session }, 'old'), /generation/)
    const live = owner.acquireSend('new', { session, contextGeneration: 1 }, 'replacement'); live.settled()
    await assert.rejects(owner.registerDerived({ sessionId: session, messageId: 'late-output', sourceIds: [] }), /generation/)
    await assert.rejects(owner.registerDerived({ sessionId: session, messageId: 'old-assistant', sourceIds: [], contextGeneration: 1 }), /retired/)
    await assert.rejects(owner.receiveSource({ sessionId: session, messageId: human.messageId, text: human.content, at: Date.now(), timezone: 'UTC', turn: 2, step: 1, admitted: true, inherited: false }), /generation/)
    await owner.commitContextRecovery(ack, () => true)
    assert.equal(owner.contextGeneration(session), 1, 'ack replay is idempotent')
  } finally { permit.settled() }
})

test('a bound ticket survives owner restart and retired derived context cannot be resurrected by cold replay or inheritance', async t => {
  const { dir, defer } = scratch(t, 'memory-context-restart-')
  let owner = openMemoryOwner({ root: dir, ...options }); defer(() => owner.close()); await owner.recover()
  const session = randomUUID(), human = await original(owner, session)
  await owner.registerDerived({ sessionId: session, messageId: 'old-reply', sourceIds: [] })
  const ticket = await owner.prepareContextRecovery({ sessionId: session, baseSurfaceHash: 'old-surface', candidates: [human] })
  const ack = bind(owner, ticket)
  await owner.close(); owner = openMemoryOwner({ root: dir, ...options }); await owner.recover()
  assert.equal(owner.contextRecovery(session)?.state, 'bound')
  await owner.commitContextRecovery(ack, () => true)
  await owner.close(); owner = openMemoryOwner({ root: dir, ...options }); await owner.recover()
  assert.equal(owner.contextGeneration(session), 1)
  assert.equal(owner.contextRecovery(session)?.replacementHash, ack.replacementHash)
  await assert.rejects(owner.registerDerived({ sessionId: session, messageId: 'old-reply', sourceIds: [], inherited: true, contextGeneration: 1 }), /retired/)
  const child = randomUUID(); owner.initializeSession({ sessionId: child, parentSessionId: session })
  await assert.rejects(owner.registerDerived({ sessionId: child, messageId: 'old-reply', sourceIds: [], inherited: true }), /retired/)
  assert.equal(owner.coordination.allowsProjectHistory({ segmentId: 'old-reply', sessionId: session, role: 'assistant', text: 'Old private content' }, undefined, undefined), false)
})

test('stale acknowledgements cannot authorize a changed source or a newer recovery ticket', async t => {
  const { dir, defer } = scratch(t, 'memory-context-cas-')
  const owner = openMemoryOwner({ root: dir, ...options }); defer(() => owner.close()); await owner.recover()
  const db = new DatabaseSync(join(dir, 'memory.db')); defer(() => db.close())
  const session = randomUUID(), human = await original(owner, session)
  const first = await owner.prepareContextRecovery({ sessionId: session, baseSurfaceHash: 'first', candidates: [human] })
  const firstAck = bind(owner, first)
  const next = await owner.prepareContextRecovery({ sessionId: session, baseSurfaceHash: 'next', candidates: [human] })
  await assert.rejects(owner.commitContextRecovery(firstAck, () => true), /conflicts/)
  const ack = bind(owner, next)
  db.prepare('UPDATE memory_sources SET withdrawn=1,text=NULL WHERE id=?').run(human.messageId)
  await assert.rejects(owner.commitContextRecovery(ack, () => true), /evidence changed/)
  assert.equal(owner.contextGeneration(session), 0)
  const safe = await owner.prepareContextRecovery({ sessionId: session, baseSurfaceHash: 'without-withdrawn', candidates: [human] })
  assert.deepEqual(safe.retainedMessageIds, [])
  await owner.commitContextRecovery(bind(owner, safe), () => true)
  assert.deepEqual(owner.dispatch.snapshot(session).sources, [])
  await assert.rejects(owner.receiveSource({ sessionId: session, messageId: human.messageId, text: human.content, at: Date.now(), timezone: 'UTC', turn: 2, step: 1, admitted: true, inherited: true, live: false, contextGeneration: 1 }), /retired/)
})

test('a parent recovery retires old child contributions without erasing the child readset or admitting old child outputs', async t => {
  const { dir, defer } = scratch(t, 'memory-context-child-')
  const owner = openMemoryOwner({ root: dir, ...options }); defer(() => owner.close()); await owner.recover()
  const parent = randomUUID(), human = await original(owner, parent), child = randomUUID()
  owner.initializeSession({ sessionId: child, parentSessionId: parent })
  const childMessage = await original(owner, child, 'I enjoy jasmine tea.')
  const p = owner.acquireSend('parent-before', { session: parent }, 'includes child'); p.settled()
  assert.ok(owner.dispatch.snapshot(parent).sources.includes(childMessage.messageId))
  const ticket = await owner.prepareContextRecovery({ sessionId: parent, baseSurfaceHash: 'with-child', candidates: [human] })
  await owner.commitContextRecovery(bind(owner, ticket), () => true)
  owner.initializeSession({ sessionId: parent })
  const current = owner.acquireSend('parent-after', { session: parent, contextGeneration: 1 }, 'safe'); current.settled()
  assert.deepEqual(owner.dispatch.snapshot(parent).sources, [human.messageId])
  assert.ok(owner.dispatch.snapshot(child).sources.includes(childMessage.messageId))
  await assert.rejects(owner.registerDerived({ sessionId: parent, senderSessionId: child, messageId: 'late-child', sourceIds: [] }), /generation/)
})

test('consecutive same-session daily updates can recover, recall the new file and send again without retaining old file receipts', async t => {
  const { dir, defer } = scratch(t, 'memory-context-daily-')
  const owner = openMemoryOwner({ root: dir, dailyNotes: { noteInterval: 1, timezone: 'UTC' }, fileMode: true,
    route: () => ({ provider: 'fake', model: 'fake' }), quiesce: async () => {}, compute: async job => {
      if (job.stage !== 'note') return '{"facts":[]}'
      const input = JSON.parse(job.input) as { existing?: { markdown: string }, turns: { user: { text: string }[] }[] }
      return JSON.stringify({ status: 'write', title: 'Notes', markdown: [input.existing?.markdown ?? '', ...input.turns.flatMap(turn => turn.user.map(s => s.text))].filter(Boolean).join('\n') })
    } })
  defer(() => owner.close()); await owner.recover()
  const session = randomUUID(), humans: { messageId: string, content: string }[] = []
  for (const [index, text] of ['I enjoy peppermint tea.', 'I listen to quiet music.', 'I read novels in the evening.'].entries()) {
    const human = await original(owner, session, text, index + 1); humans.push(human)
    await owner.completeTurn({ sessionId: session, turn: index + 1, eventSeq: index * 3 + 3, sourceIds: [human.messageId],
      assistant: '', completed: true, at: Date.now(), timezone: 'UTC', contextGeneration: owner.contextGeneration(session) })
    await owner.runtime.wake()
    if (index > 0) {
      assert.equal(owner.needsContextRecovery(session), true)
      assert.throws(() => owner.acquireSend(randomUUID(), { session, contextGeneration: owner.contextGeneration(session) }, 'stale file'), /denied/)
      const ticket = await owner.prepareContextRecovery({ sessionId: session, baseSurfaceHash: `surface-${index}`, candidates: humans })
      await owner.commitContextRecovery(bind(owner, ticket), () => true)
      assert.equal(owner.dispatch.snapshot(session).files, undefined)
    }
    const result = JSON.parse(owner.runtime.handle({ op: 'recall', session, query: 'tea music novels' }, owner.sessionContext(session))) as { notes: { text: string }[] }
    assert.equal(result.notes.length, 1)
    const permit = owner.acquireSend(randomUUID(), { session, contextGeneration: owner.contextGeneration(session) }, 'fresh note'); permit.settled()
    assert.equal(owner.dispatch.snapshot(session).files?.length, 1)
  }
  assert.equal(owner.contextGeneration(session), 2)
})

test('actual source withdrawal invalidates a prepared acknowledgement and recovered sessions exclude removed occurrences', async t => {
  const { dir, defer } = scratch(t, 'memory-context-withdraw-')
  const owner = openMemoryOwner({ root: dir, ...options }); defer(() => owner.close()); await owner.recover()
  const session = randomUUID(), human = await original(owner, session)
  const first = await owner.prepareContextRecovery({ sessionId: session, baseSurfaceHash: 'before-withdraw', candidates: [human] })
  const ack = bind(owner, first), operationId = randomUUID()
  const prepared = await owner.handleHost('prepareSourceChange', { operationId, conversation: session, ids: [human.messageId] }) as { ticket: string }
  await owner.handleHost('commitSourceChange', { operationId, ticket: prepared.ticket })
  await assert.rejects(owner.commitContextRecovery(ack, () => true), /evidence changed/)
  const ticket = await owner.prepareContextRecovery({ sessionId: session, baseSurfaceHash: 'after-withdraw', candidates: [human] })
  assert.deepEqual(ticket.retainedMessageIds, [])
  await owner.commitContextRecovery(bind(owner, ticket), () => true)
  assert.equal(owner.needsContextRecovery(session), false)
  const permit = owner.acquireSend(randomUUID(), { session, contextGeneration: 1 }, 'no old content'); permit.settled()
})

test('an unreconciled stale child triggers parent recovery before cold replay tries to attach its old file', async t => {
  const { dir, defer } = scratch(t, 'memory-context-unreconciled-child-')
  const owner = openMemoryOwner({ root: dir, ...options }); defer(() => owner.close()); await owner.recover()
  const parent = randomUUID(), human = await original(owner, parent), child = randomUUID()
  owner.initializeSession({ sessionId: child, parentSessionId: parent })
  owner.dispatch.recordFiles(child, [{ workspace: 'a'.repeat(64), id: 'missing', path: 'memory/missing.md', revision: 'missing', usageVersion: 1, policyToken: 'missing' }])
  assert.equal(owner.dispatch.snapshot(parent).files, undefined)
  assert.equal(owner.needsContextRecovery(parent), true)
  owner.initializeSession({ sessionId: parent })
  const ticket = await owner.prepareContextRecovery({ sessionId: parent, baseSurfaceHash: 'child-history', candidates: [human] })
  await owner.commitContextRecovery(bind(owner, ticket), () => true)
  assert.equal(owner.needsContextRecovery(parent), false)
  const permit = owner.acquireSend(randomUUID(), { session: parent, contextGeneration: 1 }, 'new parent context'); permit.settled()
  assert.equal(owner.needsContextRecovery(child), true, 'recovery does not silently authorize the child history')
})

test('recovery authenticates complete original content identity, including attachment-only deliveries', async t => {
  const { dir, defer } = scratch(t, 'memory-context-attachments-')
  const owner = openMemoryOwner({ root: dir, ...options }); defer(() => owner.close()); await owner.recover()
  const sessionId = randomUUID(), messageId = randomUUID(), contentDigest = 'b'.repeat(64)
  const input = { sessionId, messageId, text: '', contentDigest, at: Date.now(), timezone: 'UTC', turn: 1, step: 1, admitted: true, inherited: false }
  await owner.receiveSource(input)
  await assert.rejects(owner.receiveSource({ ...input, contentDigest: 'c'.repeat(64) }), /content identity conflicts/)
  const forged = await owner.prepareContextRecovery({ sessionId, baseSurfaceHash: 'wrong-attachment', candidates: [{ messageId, content: '', contentDigest: 'c'.repeat(64) }] })
  assert.deepEqual(forged.retainedMessageIds, [])
  const valid = await owner.prepareContextRecovery({ sessionId, baseSurfaceHash: 'original-attachment', candidates: [{ messageId, content: '', contentDigest }] })
  assert.deepEqual(valid.retainedMessageIds, [messageId])
  await owner.commitContextRecovery(bind(owner, valid), () => true)
  assert.deepEqual(owner.dispatch.snapshot(sessionId).sources, [messageId])
  await owner.receiveSource({ ...input, contextGeneration: 1, live: false })
  const permit = owner.acquireSend(randomUUID(), { session: sessionId, contextGeneration: 1 }, 'original attachment'); permit.settled()
  const textId = randomUUID()
  await owner.receiveSource({ ...input, messageId: textId, text: 'This is my tea photo.', contextGeneration: 1 })
  const changedAttachment = await owner.prepareContextRecovery({ sessionId, baseSurfaceHash: 'same-text-different-attachment',
    candidates: [{ messageId: textId, content: 'This is my tea photo.', contentDigest: 'd'.repeat(64) }] })
  assert.deepEqual(changedAttachment.retainedMessageIds, [], 'matching text never authenticates a different attached object')
})

test('unadmitted inbox originals remain available for the new turn after old model history is retired', async t => {
  const { dir, defer } = scratch(t, 'memory-context-inbox-')
  const owner = openMemoryOwner({ root: dir, ...options }); defer(() => owner.close()); await owner.recover()
  const sessionId = randomUUID(), human = await original(owner, sessionId), messageId = randomUUID()
  const inbox = { sessionId, messageId, text: 'A new independent question.', at: Date.now(), timezone: 'UTC', turn: 2, step: 1, admitted: false, inherited: false }
  await owner.receiveSource(inbox)
  const ticket = await owner.prepareContextRecovery({ sessionId, baseSurfaceHash: 'before-inbox-admission', candidates: [human, { messageId, content: inbox.text }] })
  assert.deepEqual(ticket.retainedMessageIds, [human.messageId])
  await owner.commitContextRecovery(bind(owner, ticket), () => true)
  await owner.receiveSource({ ...inbox, admitted: true, contextGeneration: 1 })
  assert.ok(owner.dispatch.snapshot(sessionId).sources.includes(messageId))
})

test('a stopped source span cannot return through full original recovery or host history reuse', async t => {
  const { openMemoryStore } = await import('../src/memory/node/memory-store.ts')
  const { openMemoryDocuments } = await import('../src/memory/node/memory-document-store.ts')
  const { memorySourceToken, memorySourceWorkspace } = await import('../src/memory/node/source-identity.ts')
  const { dir, defer } = scratch(t, 'memory-context-restriction-')
  const owner = openMemoryOwner({ root: dir, ...options, dailyNotes: true, fileMode: true }); defer(() => owner.close()); await owner.recover()
  const sessionId = randomUUID(), human = await original(owner, sessionId, '我住深圳。我喜欢茶。')
  const store = openMemoryStore(join(dir, 'memory.db')); defer(() => store.close())
  const source = store.readSource(human.messageId)!, workspace = memorySourceWorkspace(source)
  const documents = openMemoryDocuments({ db: store.db, root: store.fileRoot, source(id) {
    const source = store.readSource(id)
    return source?.text ? { text: source.text, workspace: memorySourceWorkspace(source), token: memorySourceToken(source) } : undefined
  } })
  const home = documents.commit({ operationId: 'home', workspace, path: 'digest/personal/home.md', expectedRevision: null, action: 'CREATE', markdown: '深圳',
    sources: [{ id: source.id, token: memorySourceToken(source), spans: [{ start: 0, end: 5 }] }], reads: [] })
  await owner.runtime.setDocumentEnabled({ operationId: 'stop-home', workspace, documentId: home.documentId, expectedRevision: home.revision!, expectedUsageVersion: home.usageVersion, enabled: false })
  assert.equal(owner.runtime.dispatchSourceCurrent(source.id), true, 'the remainder of this canonical source remains usable')
  const ticket = await owner.prepareContextRecovery({ sessionId, baseSurfaceHash: 'stopped-context', candidates: [human] })
  assert.deepEqual(ticket.retainedMessageIds, [], 'complete host messages cannot be safely split from text-only span permissions')
  assert.equal(owner.coordination.allowsProjectHistory({ segmentId: 'history-row', sourceId: source.id, sessionId, role: 'user', text: human.content }, undefined, undefined), false)
  assert.equal(owner.coordination.allowsProjectHistory({ segmentId: 'unknown-origin', role: 'assistant', text: 'Private previous answer' }, undefined, undefined), false)
})

test('recovery rechecks source context and project instead of treating an original message id as authorization', async t => {
  const { dir, defer } = scratch(t, 'memory-context-scopes-')
  const owner = openMemoryOwner({ root: dir, ...options }); defer(() => owner.close()); await owner.recover()
  for (const projectScoped of [false, true]) {
    const first = randomUUID(), second = randomUUID(), operationId = randomUUID(), messageId = randomUUID(), text = 'A private planning detail.'
    await owner.handleHost('sourceAlias', { operationId, sourceId: operationId, session: first, conversation: first, text,
      ...(projectScoped ? { project: { kind: 'project', id: 'project-first' } } : { context: { kind: 'conversation', id: 'private-first' } }) })
    const input = { sessionId: first, messageId, text, at: Date.now(), timezone: 'UTC', turn: 1, step: 1, admitted: true, inherited: false }
    await owner.receiveSource(input)
    await owner.receiveSource({ ...input, sessionId: second, inherited: true, ...(projectScoped ? { project: 'project-second' } : {}) })
    const ticket = await owner.prepareContextRecovery({ sessionId: second, baseSurfaceHash: `scope-${projectScoped}`, candidates: [{ messageId, content: text }] })
    assert.deepEqual(ticket.retainedMessageIds, [])
  }
})

test('saved relay receipts authenticate their original content without re-signing under the sender new generation', async t => {
  const { dir, defer } = scratch(t, 'memory-context-relay-receipt-')
  const owner = openMemoryOwner({ root: dir, ...options }); defer(() => owner.close()); await owner.recover()
  const sender = randomUUID(), recipient = randomUUID(), human = await original(owner, sender)
  await original(owner, recipient, 'Please help with planning.')
  const messageId = randomUUID(), contentDigest = 'e'.repeat(64)
  await owner.registerDerived({ sessionId: recipient, senderSessionId: sender, messageId, sourceIds: [], contentDigest,
    contextGeneration: 0, senderContextGeneration: 0 })
  const ticket = await owner.prepareContextRecovery({ sessionId: sender, baseSurfaceHash: 'sender-before', candidates: [human] })
  await owner.commitContextRecovery(bind(owner, ticket), () => true)
  await owner.registerDerived({ sessionId: recipient, senderSessionId: sender, messageId, sourceIds: [], contentDigest,
    contextGeneration: 0, senderContextGeneration: 0 })
  await assert.rejects(owner.registerDerived({ sessionId: recipient, senderSessionId: sender, messageId, sourceIds: [], contentDigest: 'f'.repeat(64),
    contextGeneration: 0, senderContextGeneration: 0 }), /identity conflicts/)
  await assert.rejects(owner.registerDerived({ sessionId: recipient, senderSessionId: sender, messageId: randomUUID(), sourceIds: [], contentDigest,
    contextGeneration: 0, senderContextGeneration: 0 }), /generation/)
  await assert.rejects(owner.registerDerived({ sessionId: recipient, senderSessionId: sender, messageId: randomUUID(), sourceIds: [], contentDigest,
    contextGeneration: 0, senderContextGeneration: 1 }), /Unverified delivery receipt/, 'reading the current sender generation cannot authenticate an old queued output')
  await owner.registerDerived({ sessionId: recipient, senderSessionId: sender, messageId: randomUUID(), sourceIds: [], contentDigest,
    contextGeneration: 0, senderContextGeneration: 1, verifiedDelivery: true })
})


test('historically readable change evidence cannot enter a recovered active dispatch readset', async t => {
  const { dir, defer } = scratch(t, 'memory-context-historical-change-')
  const owner = openMemoryOwner({ root: dir, ...options }); defer(() => owner.close()); await owner.recover()
  const session = randomUUID(), human = await original(owner, session, 'The former arrangement has ended.')
  const prior = owner.runtime.addMemory('The former arrangement applies.')
  assert.ok(prior)
  const db = new DatabaseSync(join(dir, 'memory.db')); defer(() => db.close())
  // Persist the same change-evidence role that automatic replacement assigns to a
  // canonical original; the original stays readable for audit, not active dispatch.
  db.prepare(`INSERT INTO memory_links(revision,target,kind,source,source_version,spans,created_at,automatic)
    VALUES (1,?,'end',?,1,'[]',?,1)`).run(prior.id, human.messageId, Date.now())
  assert.equal(owner.runtime.sourceCurrent(human.messageId, Date.now(), true), true)
  assert.equal(owner.runtime.dispatchSourceCurrent(human.messageId), false)
  const ticket = await owner.prepareContextRecovery({ sessionId: session, baseSurfaceHash: 'change-evidence', candidates: [human] })
  assert.deepEqual(ticket.retainedMessageIds, [])
  await owner.commitContextRecovery(bind(owner, ticket), () => true)
  assert.deepEqual(owner.dispatch.snapshot(session).sources, [])
  const permit = owner.acquireSend(randomUUID(), { session, contextGeneration: 1 }, 'clean context'); permit.settled()
})
