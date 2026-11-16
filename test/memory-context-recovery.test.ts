import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, createSystemMessage } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { memoryOriginalContentDigest, memoryRecoveryCandidates, memorySessionSurfaceHash, planMemoryContextRecovery } from '../plugins/memory/lib/context-recovery.ts'
import { createSessionIngestion } from '../plugins/memory/lib/ingestion.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { scratch } from './fixtures/scratch.js'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type {} from '@deepseek-ai/dsh-subagent'

const ownerOptions = { dailyNotes: false as const, route: () => null, compute: async () => '', quiesce: async () => {} }

test('context recovery retires the model surface while preserving the original UI transcript and permitted attachments', () => {
  const session = Session.create(SessionId('recovery-surface'))
  const original = createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'text', text: 'Keep my original request' },
    { type: 'image', attachment: { attachmentId: AttachmentId('original-image'), mediaType: 'image/png', bytes: 128, width: 1, height: 1 } },
  ] })
  const revoked = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Withdrawn address' }] })
  const generated = createUserMessage({ source: { kind: 'viva-memory' }, content: [{ type: 'text', text: 'Stale generated answer or tool context' }] })
  session.append('user/message', original, { surfaceOp: 'append' })
  session.append('user/message', revoked, { surfaceOp: 'append' })
  session.append('user/message', generated, { surfaceOp: 'append' })
  const before = memorySessionSurfaceHash(session)
  const plan = planMemoryContextRecovery(session, 'trusted-ticket', [String(original.id)])
  session.append([plan.input])
  assert.notEqual(memorySessionSurfaceHash(session), before)
  assert.equal(session.surface.nodes.length, 1)
  const visible = JSON.stringify(session.deriveMessages())
  assert.match(visible, /Keep my original request/)
  assert.match(visible, /original-image/)
  assert.equal(plan.message.content.at(-1)?.type, 'text')
  assert.deepEqual(plan.message.content.at(-1), { type: 'text', text: '\n[End of earlier user messages]\n' })
  assert.doesNotMatch(visible, /Withdrawn address|Stale generated answer/)
  assert.equal(session.snapshotEvents().filter(event => event.type === 'user/message' && event.surfaceOp === 'append').length, 3)
  assert.deepEqual(memoryRecoveryCandidates(session).map(item => item.messageId), [original.id, revoked.id])
  assert.equal(Session.create(session.id, session.snapshotEvents(), session.header).deriveMessages().length, 1)
})

test('context recovery never promotes derived role-user messages to original candidates', () => {
  const session = Session.create(SessionId('recovery-derived'))
  const generated = createUserMessage({ source: { kind: 'viva-memory' }, content: [{ type: 'text', text: 'A summary is not original evidence' }] })
  session.append('user/message', generated, { surfaceOp: 'append' })
  assert.deepEqual(memoryRecoveryCandidates(session), [])
  assert.throws(() => planMemoryContextRecovery(session, 'ticket', [generated.id]), /unavailable original/)
  const plan = planMemoryContextRecovery(session, 'ticket', [])
  session.append([plan.input])
  assert.doesNotMatch(JSON.stringify(session.deriveMessages()), /A summary is not original evidence/)
})

test('recovery retains the protected system head and replaces all subsequent surface nodes', () => {
  const session = Session.create(SessionId('recovery-system'))
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('Current host instructions') }, { surfaceOp: 'append' })
  const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Original question' }] })
  session.append('user/message', original, { surfaceOp: 'append' })
  const plan = planMemoryContextRecovery(session, 'ticket', [original.id])
  session.append([plan.input])
  assert.equal(session.surface.nodes[0], 0)
  assert.equal(session.deriveMessages()[0]?.role, 'system')
  assert.equal(session.surface.nodes.length, 2)
})

test('native recovery acknowledges the actual persisted surface and cold replay does not reattach retired derived history', async t => {
  const { dir, defer } = scratch(t, 'memory-native-recovery-')
  let owner = openMemoryOwner({ root: dir, ...ownerOptions }); defer(() => owner.close()); await owner.recover()
  const session = Session.create(SessionId('same-session'))
  const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'I enjoy peppermint tea.' }] })
  const generated = createUserMessage({ source: { kind: 'viva-memory' }, content: [{ type: 'text', text: 'A generated private conclusion' }] })
  session.append('user/message', original, { surfaceOp: 'append' })
  session.append('user/message', generated, { surfaceOp: 'append' })
  const ingestion = createSessionIngestion(owner, async () => true)
  await ingestion.synchronize(session)
  await owner.prepareContextRecovery({ sessionId: String(session.id), baseSurfaceHash: memorySessionSurfaceHash(session),
    candidates: memoryRecoveryCandidates(session).map(item => ({ messageId: item.messageId, content: item.text, contentDigest: item.contentDigest })) })
  await ingestion.recoverContext(session)
  assert.equal(owner.contextGeneration(String(session.id)), 1)
  assert.doesNotMatch(JSON.stringify(session.deriveMessages()), /generated private conclusion/)
  assert.match(JSON.stringify(session.snapshotEvents()), /generated private conclusion/)
  const incorrectlyRestored = Session.create(session.id, session.snapshotEvents().map(event => event.type === 'user/message'
    && event.data.source.kind === 'viva-memory-recovery' ? { ...event, surfaceOp: 'append' as const } : event), session.header)
  await assert.rejects(createSessionIngestion(owner, async () => true).synchronize(incorrectlyRestored), /complete model history/)
  const permit = owner.acquireSend('native-safe', { session: String(session.id), contextGeneration: 1 }, 'safe surface'); permit.settled()
  await owner.close(); owner = openMemoryOwner({ root: dir, ...ownerOptions }); await owner.recover()
  const restored = Session.create(session.id, session.snapshotEvents(), session.header)
  const cold = createSessionIngestion(owner, async () => true)
  await cold.synchronize(restored)
  assert.equal(owner.dispatch.snapshot(String(restored.id)).sources.length, 1)
  await assert.rejects(owner.registerDerived({ sessionId: String(restored.id), messageId: String(generated.id), sourceIds: [], contextGeneration: 1 }), /retired/)
  const followup = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Now continue with an unrelated request.' }] })
  await cold.receive(restored, [followup], 2, 1, true)
  restored.append('user/message', followup, { surfaceOp: 'append' })
  await cold.synchronize(restored)
  assert.match(JSON.stringify(restored.deriveMessages()), /Now continue/)
  assert.equal(owner.contextGeneration(String(restored.id)), 1)
})

test('a failed replacement flush retains the old readset and a subsequent verified rebuild recovers', async t => {
  const { dir, defer } = scratch(t, 'memory-native-recovery-flush-')
  const owner = openMemoryOwner({ root: dir, ...ownerOptions }); defer(() => owner.close()); await owner.recover()
  const session = Session.create(SessionId('failed-native-flush'))
  const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'My favorite tea is peppermint.' }] })
  session.append('user/message', original, { surfaceOp: 'append' })
  let fail = false, calls = 0
  const ingestion = createSessionIngestion(owner, async () => { calls++; return !fail || calls % 2 === 1 })
  await ingestion.synchronize(session)
  await owner.prepareContextRecovery({ sessionId: String(session.id), baseSurfaceHash: memorySessionSurfaceHash(session),
    candidates: [{ messageId: String(original.id), content: 'My favorite tea is peppermint.', contentDigest: memoryOriginalContentDigest(original) }] })
  calls = 0; fail = true
  await assert.rejects(ingestion.recoverContext(session), /durable persistence acknowledgment/)
  assert.equal(owner.contextGeneration(String(session.id)), 0)
  assert.equal(owner.contextRecovery(String(session.id))?.state, 'bound')
  assert.throws(() => owner.acquireSend('blocked', { session: String(session.id), contextGeneration: 0 }, 'old context'), /generation/)
  fail = false
  await ingestion.recoverContext(session)
  assert.equal(owner.contextGeneration(String(session.id)), 1)
  assert.equal(session.deriveMessages().length, 1)
})

test('a later forgotten original is omitted by the next generation and cannot return through title dependencies', async t => {
  const { dir, defer } = scratch(t, 'memory-native-recovery-forget-')
  const owner = openMemoryOwner({ root: dir, ...ownerOptions }); defer(() => owner.close()); await owner.recover()
  const db = new DatabaseSync(join(dir, 'memory.db')); defer(() => db.close())
  const session = Session.create(SessionId('forget-after-recovery'))
  const secret = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'A private forgotten address.' }] })
  const safe = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'I like peppermint tea.' }] })
  const secretEvent = session.append('user/message', secret, { surfaceOp: 'append' })
  session.append('user/message', safe, { surfaceOp: 'append' })
  const ingestion = createSessionIngestion(owner, async () => true)
  await ingestion.synchronize(session)
  db.prepare('UPDATE memory_sources SET withdrawn=1,text=NULL WHERE id=?').run(secret.id)
  await ingestion.recoverContext(session)
  assert.doesNotMatch(JSON.stringify(session.deriveMessages()), /private forgotten address/)
  assert.match(JSON.stringify(session.deriveMessages()), /peppermint/)
  assert.match(JSON.stringify(session.snapshotEvents()), /private forgotten address/)
  await assert.rejects(ingestion.titleDependencies(session, [secretEvent.seq]), /unknown memory sources/)
  const permit = owner.acquireSend('after-forgetting', { session: String(session.id), contextGeneration: 1 }, 'only authorized originals'); permit.settled()
})

test('recovery preserves the current inbox question for its later admission', async t => {
  const { dir, defer } = scratch(t, 'memory-native-recovery-inbox-')
  const owner = openMemoryOwner({ root: dir, ...ownerOptions }); defer(() => owner.close()); await owner.recover()
  const session = Session.create(SessionId('pending-inbox-recovery'))
  const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'I enjoy peppermint tea.' }] })
  const pending = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'My next question must not disappear.' }] })
  session.append('user/message', original, { surfaceOp: 'append' })
  const ingestion = createSessionIngestion(owner, async () => true)
  await ingestion.synchronize(session)
  await ingestion.receive(session, [pending], 2, 1, false)
  await owner.prepareContextRecovery({ sessionId: String(session.id), baseSurfaceHash: memorySessionSurfaceHash(session),
    candidates: memoryRecoveryCandidates(session).map(item => ({ messageId: item.messageId, content: item.text, contentDigest: item.contentDigest })) })
  await ingestion.recoverContext(session)
  const receipts = await ingestion.receive(session, [pending], 2, 1, true)
  assert.equal(receipts[0]?.text, 'My next question must not disappear.')
  session.append('user/message', pending, { surfaceOp: 'append' })
  await ingestion.synchronize(session)
  assert.match(JSON.stringify(session.deriveMessages()), /My next question must not disappear/)
})

test('an authenticated attachment-only original survives native recovery and cold replay', async t => {
  const { dir, defer } = scratch(t, 'memory-native-recovery-attachment-')
  const owner = openMemoryOwner({ root: dir, ...ownerOptions }); defer(() => owner.close()); await owner.recover()
  const session = Session.create(SessionId('attachment-recovery'))
  const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: {
    attachmentId: AttachmentId('retained-attachment'), mediaType: 'image/png', bytes: 128, width: 1, height: 1,
  } }] })
  session.append('user/message', original, { surfaceOp: 'append' })
  const ingestion = createSessionIngestion(owner, async () => true)
  await ingestion.synchronize(session)
  await owner.prepareContextRecovery({ sessionId: String(session.id), baseSurfaceHash: memorySessionSurfaceHash(session),
    candidates: memoryRecoveryCandidates(session).map(item => ({ messageId: item.messageId, content: item.text, contentDigest: item.contentDigest })) })
  await ingestion.recoverContext(session)
  assert.match(JSON.stringify(session.deriveMessages()), /retained-attachment/)
  assert.deepEqual(owner.contextRecovery(String(session.id))?.retainedMessageIds, [original.id])
  const cold = Session.create(session.id, session.snapshotEvents(), session.header)
  await createSessionIngestion(owner, async () => true).synchronize(cold)
  assert.match(JSON.stringify(cold.deriveMessages()), /retained-attachment/)
})

test('a recovered recipient rejects unknown old relays and cold replay only accepts an exact durable delivery receipt', async t => {
  const { dir, defer } = scratch(t, 'memory-native-delivery-receipt-')
  const owner = openMemoryOwner({ root: dir, ...ownerOptions }); defer(() => owner.close()); await owner.recover()
  const child = Session.create(SessionId('generation-zero-child'))
  child.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'An independent child task.' }] }), { surfaceOp: 'append' })
  await createSessionIngestion(owner, async () => true).synchronize(child)
  async function recipient(id: string) {
    const session = Session.create(SessionId(id))
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'An independent parent request.' }] }), { surfaceOp: 'append' })
    const intake = createSessionIngestion(owner, async () => true)
    await intake.synchronize(session)
    await owner.prepareContextRecovery({ sessionId: String(session.id), baseSurfaceHash: memorySessionSurfaceHash(session),
      candidates: memoryRecoveryCandidates(session).map(item => ({ messageId: item.messageId, content: item.text, contentDigest: item.contentDigest })) })
    await intake.recoverContext(session)
    return session
  }
  const unverified = await recipient('unknown-relay-parent')
  const stale = createUserMessage({ source: { kind: 'agent-message', form: 'relay', senderSessionId: child.id }, content: [{ type: 'text', text: 'Old delayed output' }] })
  unverified.append('user/message', stale, { surfaceOp: 'append' })
  const unknownIntake = createSessionIngestion(owner, async () => true)
  await assert.rejects(unknownIntake.synchronize(unverified), /verified delivery|receipt/i)
  await unknownIntake.recoverContext(unverified)
  assert.equal(owner.contextGeneration(String(unverified.id)), 2)
  assert.doesNotMatch(JSON.stringify(unverified.deriveMessages()), /Old delayed output/)
  const verified = await recipient('verified-relay-parent')
  const fresh = createUserMessage({ source: { kind: 'agent-message', form: 'relay', senderSessionId: child.id }, content: [{ type: 'text', text: 'Fresh explicitly authorized delivery' }] })
  verified.append('user/message', fresh, { surfaceOp: 'append' })
  await createSessionIngestion(owner, async () => true, async (_session, message) => message.id === fresh.id
    ? { contextGeneration: 1, senderContextGeneration: 0, contentDigest: memoryOriginalContentDigest(message) } : undefined).synchronize(verified)
  const cold = Session.create(verified.id, verified.snapshotEvents(), verified.header)
  await createSessionIngestion(owner, async () => true).synchronize(cold)
  const changed = Session.create(verified.id, verified.snapshotEvents().map(event => event.type === 'user/message' && event.data.id === fresh.id
    ? { ...event, data: { ...event.data, content: [{ type: 'text' as const, text: 'Different private output under the same id' }] } } : event), verified.header)
  await assert.rejects(createSessionIngestion(owner, async () => true).synchronize(changed), /content identity conflicts/)
})
