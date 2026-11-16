import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createSessionIngestion, retrievalQuestion } from '../plugins/memory/lib/ingestion.ts'
import type { ReceivedSource, CompletedTurn, DerivedSource } from '../plugins/memory/lib/owner-port.ts'

function fixture() {
  const received: ReceivedSource[] = [], completed: CompletedTurn[] = [], derived: DerivedSource[] = []
  let durable = false
  const ingestion = createSessionIngestion({
    initializeSession() {},
    async receiveSource(input) { assert.ok(durable); received.push(input); return { sourceId: `source:${input.messageId}`, text: input.text } },
    async completeTurn(input) { assert.ok(durable); completed.push(input) },
    registerDerived(input) { derived.push(input) },
    dispatch: { snapshot: () => ({ dependencies: [], sources: received.map(item => `source:${item.messageId}`), turnOnly: false, epoch: 0 }) },
  }, async () => { durable = true })
  return { ingestion, received, completed, derived }
}

test('step-three human input is registered before admission, derived role-user is never an original', async () => {
  const { ingestion, received, derived } = fixture()
  const session = Session.create(SessionId('step-three'))
  const message = createUserMessage({ content: [{ type: 'text', text: '补充：我现在负责结算' }], source: { kind: 'user' } })
  const context = createUserMessage({ content: [{ type: 'text', text: 'retrieved content' }], source: { kind: 'viva-memory' } })
  await ingestion.receive(session, [message, context], 1, 3, false)
  assert.equal(received.length, 1)
  assert.equal(received[0]!.admitted, false)
  assert.equal(received[0]!.live, true)
  await ingestion.receive(session, [message, context], 1, 3, true)
  assert.equal(received.at(-1)!.admitted, true)
  assert.equal(received.at(-1)!.step, 3)
  session.append('user/message', context, { surfaceOp: 'append' })
  await ingestion.synchronize(session)
  assert.equal(derived.length, 1)
  assert.equal(received.length, 2)
})

test('completed and canceled turns have distinct durable ingestion outcomes; replay does not repeat local work', async () => {
  const { ingestion, received, completed } = fixture()
  const session = Session.create(SessionId('complete'))
  session.append('turn/start', { turn: 1 })
  const message = createUserMessage({ content: [{ type: 'text', text: '原始输入' }], source: { kind: 'user' } })
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  await ingestion.synchronize(session)
  await ingestion.synchronize(session)
  assert.equal(received.length, 1)
  assert.deepEqual(completed.map(item => item.completed), [true, false])
  assert.deepEqual(completed[0]!.sourceIds, [`source:${message.id}`])
  assert.deepEqual(completed[1]!.sourceIds, [])
})

test('intake persistence failure blocks subsequent admission instead of skipping its source', async () => {
  let calls = 0
  const ingestion = createSessionIngestion({
    initializeSession() {},
    receiveSource: async () => { calls++; throw new Error('storage unavailable') }, completeTurn: async () => {}, registerDerived: () => {},
    dispatch: { snapshot: () => ({ dependencies: [], sources: [], turnOnly: false, epoch: 0 }) },
  }, async () => {})
  const session = Session.create(SessionId('failed'))
  const message = createUserMessage({ content: [{ type: 'text', text: 'must persist' }], source: { kind: 'user' } })
  await assert.rejects(ingestion.receive(session, [message], 1, 1, false), /storage unavailable/)
  await assert.rejects(ingestion.receive(session, [message], 1, 1, true), /storage unavailable/)
  assert.equal(calls, 1)
})


test('cold replay preserves stable source identity and a fork never completes inherited turns again', async () => {
  const original = Session.create(SessionId('parent'))
  original.append('turn/start', { turn: 1 })
  const message = createUserMessage({ content: [{ type: 'text', text: '稳定的原文' }], source: { kind: 'user' } })
  original.append('user/message', message, { surfaceOp: 'append' })
  original.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const cold = fixture()
  await cold.ingestion.synchronize(Session.create(original.id, original.snapshotEvents(), original.header))
  assert.equal(cold.received[0]!.messageId, message.id)
  assert.equal(cold.received[0]!.inherited, false)
  assert.equal(cold.received[0]!.live, false)
  assert.equal(cold.completed.length, 1)
  const id = SessionId('child')
  const fork = Session.create(id, original.snapshotEvents(), { ...original.header, id, isSeeded: true }, SessionLogOffset(original.snapshotEvents().length))
  const child = fixture()
  await child.ingestion.synchronize(fork)
  assert.equal(child.received[0]!.messageId, message.id)
  assert.equal(child.received[0]!.inherited, true)
  assert.equal(child.completed.length, 0)
})

test('a title request attaches the cited original sources and rejects an unknown source sequence', async () => {
  const { ingestion, derived } = fixture()
  const session = Session.create(SessionId('title'))
  const message = createUserMessage({ content: [{ type: 'text', text: '用于标题的原文' }], source: { kind: 'user' } })
  const event = session.append('user/message', message, { surfaceOp: 'append' })
  await ingestion.titleDependencies(session, [event.seq])
  assert.deepEqual(derived.at(-1)!.sourceIds, [`source:${message.id}`])
  await assert.rejects(ingestion.titleDependencies(session, [999]), /unknown memory sources/)
})


test('attachment-only human input keeps its original identity before send and through cold replay', async () => {
  const session = Session.create(SessionId('attachment-original'))
  const image = createUserMessage({ content: [{ type: 'image', attachment: {
    attachmentId: AttachmentId('image-digest'), mediaType: 'image/png', bytes: 128, width: 1, height: 1,
  } }], source: { kind: 'user' } })
  const file = createUserMessage({ content: [{ type: 'file', attachment: {
    attachmentId: AttachmentId('file-digest'), name: 'notes.txt', bytes: 32,
  } }], source: { kind: 'user' } })
  const { ingestion, received, derived } = fixture()
  await ingestion.receive(session, [image, file], 1, 1, false)
  await ingestion.receive(session, [image, file], 1, 1, true)
  assert.deepEqual(received.map(item => item.messageId), [image.id, file.id, image.id, file.id])
  assert.ok(received.every(item => item.text === ''), 'attachment bytes and names are not invented factual text')
  session.append('user/message', image, { surfaceOp: 'append' })
  session.append('user/message', file, { surfaceOp: 'append' })
  await ingestion.synchronize(session)
  assert.equal(derived.length, 0, 'attachment input is original, not generated context')
  const cold = fixture()
  await cold.ingestion.synchronize(Session.create(session.id, session.snapshotEvents(), session.header))
  assert.deepEqual(cold.received.map(item => item.messageId), [image.id, file.id])
  assert.ok(cold.received.every(item => item.live === false))
})


test('trusted derived input queries memory but remains excluded from daily original sources', async () => {
  const session = Session.create(SessionId('derived-task'))
  const completed: CompletedTurn[] = []
  const original = createUserMessage({ content: [{ type: 'text', text: '原始工作要求' }], source: { kind: 'user' } })
  const derived = createUserMessage({ content: [{ type: 'text', text: '<host-wire>项目任务</host-wire>' }], source: { kind: 'user' } })
  const ingestion = createSessionIngestion({
    initializeSession() {},
    async receiveSource(input) { return input.messageId === derived.id
      ? { sourceId: 'derived-task-source', text: '', handledIntent: true, retrievalQuery: '项目任务' }
      : { sourceId: 'human-source', text: input.text } },
    async completeTurn(input) { completed.push(input) }, registerDerived() {},
    dispatch: { snapshot: () => ({ dependencies: [], sources: ['human-source'], turnOnly: false, epoch: 0 }) },
  }, async () => {})
  session.append('turn/start', { turn: 1 })
  const receipts = await ingestion.receive(session, [original, derived], 1, 1, true)
  assert.equal(retrievalQuestion(receipts), '原始工作要求\n项目任务')
  session.append('user/message', original, { surfaceOp: 'append' })
  session.append('user/message', derived, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ingestion.synchronize(session)
  assert.deepEqual(completed[0]!.sourceIds, ['human-source'])
  assert.equal(retrievalQuestion([{ sourceId: 'control', text: '忘记 #1', handledIntent: true,
    retrievalQuery: 'must not query', controlReceipt: { operationId: 'done', kind: 'stop', targetId: 1 } }]), '')
})

test('native session workspace is bound before original or derived replay, independent of parent IPC', async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { openMemoryOwner } = await import('../src/memory/node/owner.ts')
  const { memoryProjectScope } = await import('../src/memory/node/project-scope.ts')
  const root = mkdtempSync(join(tmpdir(), 'memory-native-project-'))
  const project = (name: string) => {
    const dir = join(root, name)
    mkdirSync(join(dir, '.git', 'objects'), { recursive: true })
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    return dir
  }
  const first = project('first'), second = project('second'), nested = join(first, 'nested')
  mkdirSync(nested)
  const owner = openMemoryOwner({ root: join(root, 'memory'), compute: () => null, route: () => null, quiesce: async () => {} })
  t.after(async () => { await owner.close(); rmSync(root, { recursive: true, force: true }) })
  await owner.recover()
  const ingestion = createSessionIngestion(owner, async () => {})
  const native = (id: string, cwd: string) => {
    const seed = Session.create(SessionId(id))
    return Session.create(seed.id, [], { ...seed.header, cwd })
  }
  const parent = native('parent-project', first)
  const message = createUserMessage({ content: [{ type: 'text', text: '项目资料' }], source: { kind: 'user' } })
  parent.append('user/message', message, { surfaceOp: 'append' })
  await ingestion.synchronize(parent)
  assert.deepEqual(owner.sessionContext(String(parent.id)).project, memoryProjectScope(first))
  const sameId = SessionId('same-project-child')
  const same = Session.create(sameId, parent.snapshotEvents(), { ...parent.header, id: sameId, cwd: nested, isSeeded: true }, SessionLogOffset(parent.snapshotEvents().length))
  await ingestion.synchronize(same)
  assert.equal(await owner.handleHost('bindProject', { args: [String(same.id), memoryProjectScope(nested)] }), true)
  assert.deepEqual(owner.sessionContext(String(same.id)).project, memoryProjectScope(first))
  assert.throws(() => owner.initializeSession({ sessionId: String(same.id), cwd: second }), /project/)
  const other = native('other-project', second)
  await ingestion.synchronize(other)
  assert.deepEqual(owner.sessionContext(String(other.id)).project, memoryProjectScope(second))
  assert.equal(await owner.handleHost('bindProject', { args: [String(other.id), memoryProjectScope(first)] }), false)
})

test('native subagent prompt is derived while authenticated browser followup remains original', async () => {
  const { ingestion, received } = fixture()
  const id = SessionId('native-child')
  const child = Session.create(id, [], { ...Session.create(id).header, origin: 'subagent', parentSession: SessionId('native-parent') })
  const generated = createUserMessage({ content: [{ type: 'text', text: '记住：模型编造的事实' }], source: { kind: 'user' } })
  const browserSource = { kind: 'user' as const, rpcId: 'browser-request' }
  const human = createUserMessage({ content: [{ type: 'text', text: '这是我亲自输入的补充' }], source: browserSource })
  await ingestion.receive(child, [generated, human], 1, 1, true)
  assert.deepEqual(received.map(input => input.derived), [true, false])
  const orphan = Session.create(SessionId('orphan'), [], { ...Session.create(SessionId('orphan')).header, origin: 'subagent' })
  await assert.rejects(ingestion.receive(orphan, [generated], 1, 1, false), /Subagent parent/)
})

test('native settlement and relay messages attach sender evidence before admitting their text', async () => {
  const { ingestion, derived, received } = fixture()
  const parent = Session.create(SessionId('relay-parent'))
  const source = { kind: 'agent-message' as const, form: 'relay' as const, senderSessionId: SessionId('sender') }
  const relay = createUserMessage({ content: [{ type: 'text', text: '模型产生的结果' }], source })
  await ingestion.receive(parent, [relay], 1, 1, false)
  assert.equal(received.length, 0)
  assert.equal(derived[0]?.senderSessionId, 'sender')
})
