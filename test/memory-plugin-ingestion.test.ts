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
  }, async () => { durable = true; return true })
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
  }, async () => true)
  const session = Session.create(SessionId('failed'))
  const message = createUserMessage({ content: [{ type: 'text', text: 'must persist' }], source: { kind: 'user' } })
  await assert.rejects(ingestion.receive(session, [message], 1, 1, false), /storage unavailable/)
  await assert.rejects(ingestion.receive(session, [message], 1, 1, true), /storage unavailable/)
  assert.equal(calls, 1)
})

test('resolved flush without a participating persistence listener is not a durable receipt', async () => {
  let received = 0
  const ingestion = createSessionIngestion({
    initializeSession() {},
    receiveSource: async () => { received++; return { sourceId: 'source', text: 'must persist' } },
    completeTurn: async () => {}, registerDerived() {},
    dispatch: { snapshot: () => ({ dependencies: [], sources: [], turnOnly: false, epoch: 0 }) },
  }, async () => false)
  const session = Session.create(SessionId('no-persistence-listener'))
  const message = createUserMessage({ content: [{ type: 'text', text: 'must persist' }], source: { kind: 'user' } })
  session.append('user/message', message, { surfaceOp: 'append' })
  await assert.rejects(ingestion.synchronize(session), /durable persistence acknowledgment/)
  assert.equal(received, 0)
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
  }, async () => true)
  session.append('turn/start', { turn: 1 })
  const receipts = await ingestion.receive(session, [original, derived], 1, 1, true)
  assert.equal(retrievalQuestion(receipts), '原始工作要求\n项目任务')
  session.append('user/message', original, { surfaceOp: 'append' })
  session.append('user/message', derived, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ingestion.synchronize(session)
  assert.deepEqual(completed[0]!.sourceIds, ['human-source'])
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
  const ingestion = createSessionIngestion(owner, async () => true)
  const native = (id: string, cwd: string) => {
    const seed = Session.create(SessionId(id))
    return Session.create(seed.id, [], { ...seed.header, cwd })
  }
  const parent = native('parent-project', first)
  const message = createUserMessage({ content: [{ type: 'text', text: '项目资料' }], source: { kind: 'user' } })
  parent.append('user/message', message, { surfaceOp: 'append' })
  await ingestion.synchronize(parent)
  assert.deepEqual(owner.sessionContext(String(parent.id)).project, memoryProjectScope(first))
  assert.deepEqual(owner.sessionContext(String(parent.id)).context, memoryProjectScope(first))
  const sameId = SessionId('same-project-child')
  const same = Session.create(sameId, parent.snapshotEvents(), { ...parent.header, id: sameId, cwd: nested, isSeeded: true }, SessionLogOffset(parent.snapshotEvents().length))
  await ingestion.synchronize(same)
  assert.equal(await owner.handleHost('bindProject', { args: [String(same.id), memoryProjectScope(nested)] }), true)
  assert.deepEqual(owner.sessionContext(String(same.id)).project, memoryProjectScope(first))
  assert.deepEqual(owner.sessionContext(String(same.id)).context, memoryProjectScope(first))
  await owner.handleHost('sourceAlias', { operationId: 'same-project-alias', sourceId: 'same-project-alias', session: String(same.id),
    conversation: 'new-project-topic', text: 'Project followup with an omitted scope' })
  assert.deepEqual(owner.sessionContext(String(same.id)).context, memoryProjectScope(first))
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

test('real native intake binds foreground originals to user scope and subagent human followups to task scope across restart', async t => {
  const { scratch } = await import('./fixtures/scratch.js')
  const { openMemoryOwner } = await import('../src/memory/node/owner.ts')
  const { DatabaseSync } = await import('node:sqlite')
  const { join } = await import('node:path')
  const { dir, defer } = scratch(t, 'memory-native-default-scope-')
  const options = { root: dir, compute: () => null, route: () => null, quiesce: async () => {} }
  let owner = openMemoryOwner(options)
  defer(() => owner.close())
  await owner.recover()
  const parent = Session.create(SessionId('foreground-root'))
  const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'I write a weekly report.' }] })
  parent.append('user/message', original, { surfaceOp: 'append' })
  await createSessionIngestion(owner, async () => true).synchronize(parent)
  assert.deepEqual(owner.sessionContext(String(parent.id)).context, { kind: 'user' })
  const id = SessionId('verified-subagent')
  const child = Session.create(id, [], { ...Session.create(id).header, origin: 'subagent', parentSession: parent.id })
  const generated = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Generated child instructions' }] })
  const browserSource = { kind: 'user' as const, rpcId: 'authenticated-browser-followup' }
  const human = createUserMessage({ source: browserSource, content: [{ type: 'text', text: 'Only this delegated task uses this address.' }] })
  child.append('user/message', generated, { surfaceOp: 'append' })
  child.append('user/message', human, { surfaceOp: 'append' })
  await createSessionIngestion(owner, async () => true).synchronize(child)
  const task = { kind: 'task', id: String(child.id) }
  assert.deepEqual(owner.sessionContext(String(child.id)).context, task)
  owner.initializeSession({ sessionId: String(child.id) })
  assert.deepEqual(owner.sessionContext(String(child.id)).context, task)
  const db = new DatabaseSync(join(dir, 'memory.db'))
  defer(() => db.close())
  const contexts = db.prepare('SELECT id,context,conversation FROM memory_sources ORDER BY id').all()
  assert.equal(contexts.length, 2, 'the generated subagent prompt has no canonical source')
  assert.deepEqual(JSON.parse(String(contexts.find(row => row.id === original.id)?.context)), { kind: 'user' })
  assert.deepEqual(JSON.parse(String(contexts.find(row => row.id === human.id)?.context)), task)
  assert.equal(contexts.find(row => row.id === human.id)?.conversation, String(child.id))
  await assert.rejects(owner.handleHost('sourceAlias', { operationId: 'widen-child', sourceId: 'widen-child', session: String(child.id),
    conversation: String(child.id), text: 'Widening is rejected', context: { kind: 'user' } }), /task context changed/)
  assert.throws(() => owner.initializeSession({ sessionId: String(parent.id), parentSessionId: String(child.id) }), /cycle/)
  const late = Session.create(SessionId('already-foreground'))
  late.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Already accepted as foreground' }] }), { surfaceOp: 'append' })
  await createSessionIngestion(owner, async () => true).synchronize(late)
  assert.throws(() => owner.initializeSession({ sessionId: String(late.id), parentSessionId: String(parent.id) }), /role changed/)
  assert.equal(db.prepare('SELECT 1 FROM owner_session_parents WHERE session=?').get(String(late.id)), undefined)
  await owner.close()
  owner = openMemoryOwner(options)
  await owner.recover()
  for (const session of [parent, child]) {
    await createSessionIngestion(owner, async () => true).synchronize(Session.create(session.id, session.snapshotEvents(), session.header))
  }
  assert.deepEqual(owner.sessionContext(String(parent.id)).context, { kind: 'user' })
  assert.deepEqual(owner.sessionContext(String(child.id)).context, task)
  assert.equal(db.prepare('SELECT count(*) AS n FROM memory_sources').get()?.n, 3)
})

test('native initialization and omitted alias scope preserve host task restrictions and reject a staged wider alias', async t => {
  const { scratch } = await import('./fixtures/scratch.js')
  const { openMemoryOwner } = await import('../src/memory/node/owner.ts')
  const { dir, defer } = scratch(t, 'memory-native-host-scope-')
  const owner = openMemoryOwner({ root: dir, compute: () => null, route: () => null, quiesce: async () => {} })
  defer(() => owner.close())
  await owner.recover()
  const task = { kind: 'task' as const, id: 'host-task' }, id = SessionId('host-task-session')
  const { randomUUID } = await import('node:crypto')
  const originalId = randomUUID(), followupId = randomUUID(), stagedId = randomUUID()
  await owner.handleHost('sourceAlias', { operationId: originalId, sourceId: originalId, session: String(id),
    conversation: 'task-conversation', text: 'Host task instruction', context: task })
  owner.initializeSession({ sessionId: String(id), cwd: dir })
  await owner.handleHost('sourceAlias', { operationId: followupId, sourceId: followupId, session: String(id),
    conversation: 'task-conversation', text: 'Task followup' })
  assert.deepEqual(owner.sessionContext(String(id)).context, task)
  const session = Session.create(id, [], { ...Session.create(id).header, cwd: dir })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Task followup' }] }), { surfaceOp: 'append' })
  await createSessionIngestion(owner, async () => true).synchronize(session)
  assert.deepEqual(owner.sessionContext(String(id)).context, task)
  const parent = Session.create(SessionId('parent'))
  await createSessionIngestion(owner, async () => true).synchronize(parent)
  const childId = SessionId('staged-child')
  await owner.handleHost('sourceAlias', { operationId: stagedId, sourceId: stagedId, session: String(childId),
    conversation: String(childId), text: 'Staged wider original', context: { kind: 'user' } })
  const child = Session.create(childId, [], { ...Session.create(childId).header, origin: 'subagent', parentSession: parent.id })
  const browserSource = { kind: 'user' as const, rpcId: 'browser-request' }
  child.append('user/message', createUserMessage({ source: browserSource, content: [{ type: 'text', text: 'Staged wider original' }] }), { surfaceOp: 'append' })
  await assert.rejects(createSessionIngestion(owner, async () => true).synchronize(child), /Source alias task context changed/)
})
