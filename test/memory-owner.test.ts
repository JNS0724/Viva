import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { createNativeOutputAttempts } from '../src/memory/node/native-output-attempts.ts'
import { createNativeOutputJournal } from '../src/memory/node/native-output-journal.ts'

function fixture(t: import('node:test').TestContext, hostNamespace?: string) {
  const root = mkdtempSync(join(tmpdir(), 'memory-owner-'))
  const owner = openMemoryOwner({ root, hostNamespace, fileMode: true, compute: () => null, route: () => null, quiesce: async () => {} })
  t.after(async () => { await owner.close(); rmSync(root, { recursive: true, force: true }) })
  return { owner, root }
}
const source = (overrides: Partial<Parameters<ReturnType<typeof openMemoryOwner>['receiveSource']>[0]> = {}) => ({
  sessionId: randomUUID(), messageId: randomUUID(), text: '我在深圳工作', at: Date.now(), timezone: 'Asia/Shanghai', turn: 1, step: 1,
  admitted: true, inherited: false, ...overrides,
})
test('native output evidence retains exact file ranges across sends without persisting file names', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const outputs = createNativeOutputAttempts(db)
    const attempt = { id: randomUUID(), session: 'session', generation: 0, turn: 1, step: 2, floor: 12 }
    const first = source().messageId, second = source().messageId
    const fileProof = (sourceId: string, start: number, end: number) => ({
      dependencies: [], sources: [sourceId], fileSources: [sourceId], epoch: 0, turnOnly: false,
      files: [{ workspace: '0'.repeat(64), id: 'file', path: 'digest/wiki/sensitive-file-name.md', revision: 'rev',
        usageVersion: 0, policyToken: 'policy', sourceRanges: [{ sourceId, spans: [{ start, end }] }] }],
    })
    outputs.record(attempt, fileProof(first, 2, 8))
    outputs.record(attempt, fileProof(second, 9, 20))
    outputs.record(attempt, fileProof(first, 2, 8))
    const readsets = db.prepare('SELECT evidence FROM owner_native_output_reads').all()
    assert.equal(readsets.length, 2)
    assert.doesNotMatch(JSON.stringify(readsets), /sensitive-file-name|policy/)
    assert.deepEqual(outputs.affected([{ sourceId: first, spans: [{ start: 8, end: 9 }] }], []), [])
    const overlapping = [{ sourceId: second, spans: [{ start: 12, end: 13 }] }]
    assert.deepEqual(outputs.affected(overlapping, []), [{ ...attempt, result: { state: 'open' } }])
    const terminal = { seq: 14, kind: 'attempt', digest: 'a'.repeat(64) } as const
    // A settlement may arrive after an erasure was planned from the open receipt.
    outputs.finish(attempt, terminal)
    outputs.finish(attempt, terminal)
    assert.deepEqual(outputs.affected(overlapping, []), [{ ...attempt, result: { state: 'settled', terminal } }])
    assert.throws(() => outputs.finish(attempt, { ...terminal, seq: 15 }), /settlement conflicts/)
    const abandonedBeforeSend = { ...attempt, id: randomUUID() }
    outputs.finish(abandonedBeforeSend)
    assert.throws(() => outputs.record(abandonedBeforeSend, fileProof(second, 9, 20)), /attempt identity conflicts/)
    assert.equal(outputs.affected(overlapping, []).length, 1)
  } finally { db.close() }
})
test('settled native output publication leaves an immutable receipt when another target arrives', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const invalidated: string[] = []
    const journal = createNativeOutputJournal(db, session => invalidated.push(session))
    const operation = journal.forOperation(randomUUID())
    const session = randomUUID(), digest = (char: string) => char.repeat(64)
    const first = { attempt: randomUUID(), seq: 32, before: digest('1'), after: digest('2'), trace: digest('3') }
    const next = { attempt: randomUUID(), seq: 28, before: digest('4'), after: digest('5') }
    const original = { before: digest('a'), after: digest('b'), events: digest('1') }
    const followup = { before: digest('b'), after: digest('c'), events: digest('2') }
    operation.prepare(session, { intent: original, replacements: [first] })
    assert.throws(() => operation.prepare(session, { intent: followup, replacements: [first, next] }), /UNIQUE/u)
    operation.finish(session, original)
    operation.prepare(session, { intent: followup, replacements: [next] })
    assert.deepEqual(operation.pendingSessions(), [session])
    assert.deepEqual(operation.read(session).map(item => item.replacements), [[next], [first]])
    assert.deepEqual(operation.provenProjection(first), first)
    assert.equal(operation.provenProjection(next), undefined)
    operation.finish(session, followup)
    operation.complete([first.attempt, next.attempt])
    assert.equal(journal.erased(next.attempt), true)
    assert.deepEqual(invalidated, [session, session])
  } finally { db.close() }
})

test('owner refuses a second process-local connection and can reopen after close', async t => {
  const { owner, root } = fixture(t)
  assert.throws(() => openMemoryOwner({ root, compute: () => null, route: () => null, quiesce: async () => {} }), /active owner/)
  await owner.close()
  const next = openMemoryOwner({ root, compute: () => null, route: () => null, quiesce: async () => {} })
  await next.recover(); await next.close()
})
test('received original is durable before automatic processing, cancellation keeps it unprocessed', async t => {
  const { owner, root } = fixture(t)
  await owner.recover()
  const input = source()
  const receipt = await owner.receiveSource(input)
  const db = new DatabaseSync(join(root, 'memory.db')); t.after(() => db.close())
  assert.equal(db.prepare('SELECT outcome FROM memory_sources WHERE id=?').get(receipt.sourceId)?.outcome, 'received')
  await owner.completeTurn({ sessionId: input.sessionId, turn: 1, eventSeq: 3, sourceIds: [receipt.sourceId], assistant: '', completed: false, at: input.at, timezone: input.timezone })
  assert.equal(db.prepare('SELECT outcome FROM memory_sources WHERE id=?').get(receipt.sourceId)?.outcome, 'received')
  assert.equal(owner.runtime.listMemories().total, 0)
})
test('completion promotes source once and keeps original capture time', async t => {
  const { owner, root } = fixture(t); await owner.recover()
  const input = source({ at: 1730000000000 })
  const receipt = await owner.receiveSource(input)
  const complete = { sessionId: input.sessionId, turn: 1, eventSeq: 3, sourceIds: [receipt.sourceId], assistant: '收到', completed: true, at: input.at, timezone: input.timezone }
  await owner.completeTurn(complete); await owner.completeTurn(complete)
  const db = new DatabaseSync(join(root, 'memory.db')); t.after(() => db.close())
  const row = db.prepare('SELECT outcome,at FROM memory_sources WHERE id=?').get(receipt.sourceId)
  assert.equal(row?.outcome, 'note-pending'); assert.equal(row?.at, input.at)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM owner_turns').get()?.n, 1)
})
test('source alias matches only exact trusted wire text and does not strip user markers', async t => {
  const { owner } = fixture(t); await owner.recover()
  const input = source({ text: '[user-message]literal[/user-message]' })
  assert.equal((await owner.receiveSource(input)).text, input.text)
  const next = source({ text: '[host]真实原文[/host]' }), id = randomUUID()
  await owner.handleHost('sourceAlias', { operationId: id, sourceId: id, session: next.sessionId, conversation: 'host-thread', text: '真实原文', wireText: next.text })
  assert.equal((await owner.receiveSource(next)).text, '真实原文')
  await assert.rejects(owner.receiveSource({ ...next, text: 'changed' }), /identity conflicts/)
})
test('native source proof keeps trusted wire locations after its delivery payload is consumed', async t => {
  const { owner, root } = fixture(t); await owner.recover()
  const input = source({ contentDigest: 'f'.repeat(64) }), sourceId = randomUUID()
  const wireText = `${input.text}\n\n${input.text}`
  await owner.handleHost('sourceAlias', { operationId: sourceId, sourceId, text: input.text, session: input.sessionId, conversation: 'host-thread' })
  await assert.rejects(owner.handleHost('bindWireAlias', { args: [input.sessionId, input.text, wireText, sourceId] }), /unique verbatim/)
  const spans = [{ start: input.text.length + 2, end: wireText.length }]
  const delivery = await owner.handleHost('bindWireAlias', { args: [input.sessionId, input.text, wireText, sourceId, spans] }) as { wireText: string }
  assert.equal((await owner.receiveSource({ ...input, text: delivery.wireText })).sourceId, sourceId)
  const db = new DatabaseSync(join(root, 'memory.db'), { readOnly: true }); t.after(() => db.close())
  const proof = db.prepare('SELECT source_hash,spans FROM owner_message_wires WHERE message=?').get(input.messageId)
  assert.ok(proof?.source_hash)
  assert.deepEqual(JSON.parse(String(proof.spans)), spans)
  assert.equal(db.prepare('SELECT count(*) AS n FROM owner_aliases WHERE payload IS NOT NULL').get()?.n, 0)
  const generated = await owner.handleHost('bindWireAlias', { args: [input.sessionId, 'id=', 'id='] }) as { wireText: string }
  const message = source({ ...input, messageId: randomUUID(), text: generated.wireText })
  assert.equal((await owner.receiveSource(message)).retrievalQuery, 'id=')
  assert.equal((await owner.receiveSource(message)).retrievalQuery, 'id=')
  assert.equal(db.prepare('SELECT source_hash FROM owner_message_wires WHERE message=?').get(message.messageId)?.source_hash, null)
})

test('prepared source change survives restart, denies send until host commit, and preserves live fork occurrence', async t => {
  const { owner, root } = fixture(t); await owner.recover()
  const input = source(), receipt = await owner.receiveSource(input)
  const fork = source({ ...input, sessionId: randomUUID(), inherited: true })
  await owner.receiveSource(fork)
  const operationId = randomUUID()
  const prepared = await owner.handleHost('prepareSourceChange', { operationId, conversation: input.sessionId, ids: [] }) as { ticket: string }
  assert.throws(() => owner.acquireSend(randomUUID(), { session: fork.sessionId }, 'payload'))
  await owner.close()
  const next = openMemoryOwner({ root, compute: () => null, route: () => null, quiesce: async () => {} }); t.after(() => next.close())
  await next.recover(); assert.equal(next.ready(), false)
  await next.handleHost('commitSourceChange', { operationId, ticket: prepared.ticket })
  assert.equal(next.ready(), true)
  assert.equal(next.runtime.sourceCurrent(receipt.sourceId), true)
  assert.equal(next.needsContextRecovery(input.sessionId), true)
  assert.equal(next.needsContextRecovery(fork.sessionId), false)
  const permit = next.acquireSend(randomUUID(), { session: fork.sessionId }, 'payload'); permit.settled()
})
test('failed revision validation is terminal and cannot poison owner recovery', async t => {
  const { owner, root } = fixture(t); await owner.recover()
  const created = await owner.handleHost('createFile', { args: [{ operationId: randomUUID(), text: '每周五提交周报。' }] }) as import('../src/memory/contracts/file-management.ts').MemoryFileMutationResult
  const detail = owner.runtime.readFile(created.identity)!
  const operationId = randomUUID()
  await assert.rejects(owner.handleHost('editFile', { args: [{ operationId, identity: created.identity,
    version: { ...detail.version, contentRevision: 'stale' }, text: '改成周一。' }] }))
  assert.equal((await owner.handleHost('getOperation', { operationId }) as { state: string }).state, 'failed')
  await owner.close()
  const next = openMemoryOwner({ root, compute: () => null, route: () => null, quiesce: async () => {} })
  try { await next.recover(); assert.equal(next.ready(), true) } finally { await next.close() }
})
test('forget emits durable versioned host effects and ack never accepts a mismatched cause', async t => {
  const { owner } = fixture(t, 'viva'); await owner.recover()
  const created = await owner.handleHost('createFile', { args: [{ operationId: randomUUID(), text: '每周五提交周报。' }] }) as import('../src/memory/contracts/file-management.ts').MemoryFileMutationResult
  const detail = owner.runtime.readFile(created.identity)!, operationId = randomUUID()
  await owner.handleHost('forgetFile', { args: [{ operationId, identity: created.identity, version: detail.version }] })
  const effects = await owner.handleHost('pendingHostEffects', {}) as Array<{ effectId: string, causeOperationId: string, revision: number }>
  assert.equal(effects.length, 1)
  assert.equal(effects[0]!.causeOperationId, operationId)
  assert.equal((await owner.handleHost('getOperation', { operationId }) as { cleanup: string }).cleanup, 'pending')
  await assert.rejects(owner.handleHost('ackHostEffect', { ...effects[0], causeOperationId: randomUUID() }), /Unrecognized|conflicts/)
  const { effectId, causeOperationId, revision } = effects[0]!
  await owner.handleHost('ackHostEffect', { effectId, causeOperationId, revision })
  await owner.handleHost('ackHostEffect', { effectId, causeOperationId, revision })
  assert.deepEqual(await owner.handleHost('pendingHostEffects', {}), [])
  assert.equal((await owner.handleHost('getOperation', { operationId }) as { cleanup: string }).cleanup, 'pending', 'native replica receipt remains independent from the host acknowledgement')
  await assert.rejects(owner.handleHost('ackHostEffect', { effectId, causeOperationId: randomUUID(), revision }), /conflicts/)
})
test('project binding reaches the physical fence before any host source alias exists', async t => {
  const { owner } = fixture(t); await owner.recover()
  const session = randomUUID(), project = { kind: 'project' as const, id: 'project-a' }
  assert.equal(await owner.handleHost('bindProject', { args: [session, project] }), true)
  assert.deepEqual(owner.sessionContext(session).project, project)
  const id = randomUUID()
  await owner.handleHost('sourceAlias', { operationId: id, sourceId: id, session, conversation: 'actual-host-thread', text: '项目使用 TypeScript', project })
  await owner.receiveSource(source({ sessionId: session, text: '项目使用 TypeScript' }))
  const permit = owner.acquireSend(randomUUID(), { session }, 'payload'); permit.settled()
})
test('cold derived replay keeps its original read set instead of absorbing future session sources', async t => {
  const { owner } = fixture(t); await owner.recover()
  const first = source(); const a = await owner.receiveSource(first)
  const derived = { sessionId: first.sessionId, messageId: randomUUID(), sourceIds: [a.sourceId] }
  await owner.registerDerived(derived)
  const b = await owner.receiveSource(source({ sessionId: first.sessionId }))
  await owner.registerDerived({ ...derived, sourceIds: [a.sourceId, b.sourceId] })
  const fork = randomUUID()
  await owner.registerDerived({ ...derived, sessionId: fork, inherited: true, sourceIds: [] })
  assert.deepEqual(owner.dispatch.snapshot(fork).sources, [a.sourceId])
})
test('custom question answer uses the owner native turn and joins only completed-turn processing', async t => {
  const { owner, root } = fixture(t); await owner.recover()
  const original = source({ turn: 3 }); await owner.receiveSource(original)
  const card = { id: 'drink', question: '你喜欢什么饮品？', header: '', multiSelect: false, options: [{ label: '茶' }] }
  const context = { kind: 'conversation' as const, id: original.sessionId }
  const args = [original.sessionId, randomUUID(), [card], original.sessionId, context, undefined, 'show']
  assert.equal(await owner.handleHost('authorizeGeneralQuestion', { args }), true)
  args[6] = 'check'; assert.equal(await owner.handleHost('authorizeGeneralQuestion', { args }), true)
  const operationId = randomUUID()
  const answer = { operationId, session: original.sessionId, conversation: original.sessionId, text: '我喜欢茉莉花茶', question: card.question,
    requestId: 'request', questionId: card.id, context }
  assert.deepEqual(await owner.handleHost('acceptQuestionAnswer', answer), { sourceId: operationId })
  assert.deepEqual(await owner.handleHost('acceptQuestionAnswer', answer), { sourceId: operationId })
  await owner.completeTurn({ sessionId: original.sessionId, turn: 3, eventSeq: 10, sourceIds: [], assistant: '收到', completed: true, at: Date.now(), timezone: 'Asia/Shanghai' })
  const db = new DatabaseSync(join(root, 'memory.db'))
  try { assert.equal(db.prepare('SELECT outcome FROM memory_sources WHERE id=?').get(operationId)?.outcome, 'note-pending') } finally { db.close() }
})
test('withdrawal tombstones an alias not yet delivered, including after process restart', async t => {
  const { owner, root } = fixture(t); await owner.recover()
  const input = source(), id = randomUUID()
  const alias = { operationId: id, sourceId: id, session: input.sessionId, conversation: 'host-thread', text: input.text }
  await owner.handleHost('sourceAlias', alias)
  const operationId = randomUUID()
  const { ticket } = await owner.handleHost('prepareSourceChange', { operationId, conversation: 'host-thread', ids: [] }) as { ticket: string }
  await owner.handleHost('commitSourceChange', { operationId, ticket })
  await assert.rejects(owner.receiveSource(input), /withdrawn/)
  await assert.rejects(owner.handleHost('sourceAlias', alias), /withdrawn/)
  await owner.close()
  const next = openMemoryOwner({ root, compute: () => null, route: () => null, quiesce: async () => {} })
  try {
    await next.recover()
    await assert.rejects(next.receiveSource(input), /withdrawn/)
    const db = new DatabaseSync(join(root, 'memory.db'))
    try { assert.equal(db.prepare('SELECT payload FROM owner_aliases WHERE id=?').get(id)?.payload, null) } finally { db.close() }
  } finally { await next.close() }
})
test('memory rejection does not erase original-delivery admission and remains withdrawable', async t => {
  const { owner, root } = fixture(t); await owner.recover()
  const input = source({ text: 'password: dummy-test-secret' })
  const received = await owner.receiveSource(input)
  const db = new DatabaseSync(join(root, 'memory.db'))
  try {
    const record = db.prepare('SELECT text,hash,outcome FROM memory_sources WHERE id=?').get(received.sourceId)
    assert.equal(record?.text, null); assert.equal(record?.hash, null); assert.equal(record?.outcome, 'rejected')
  } finally { db.close() }
  const permit = owner.acquireSend(randomUUID(), { session: input.sessionId }, 'body'); permit.settled()
  await owner.completeTurn({ sessionId: input.sessionId, turn: 1, eventSeq: 4, sourceIds: [received.sourceId], assistant: '', completed: true, at: input.at, timezone: input.timezone })
  const operationId = randomUUID()
  const { ticket } = await owner.handleHost('prepareSourceChange', { operationId, conversation: input.sessionId, ids: [received.sourceId] }) as { ticket: string }
  await owner.handleHost('commitSourceChange', { operationId, ticket })
  assert.throws(() => owner.acquireSend(randomUUID(), { session: input.sessionId }, 'body'))
})
test('an independent owner queues native cleanup without inventing a host consumer', async t => {
  const { owner } = fixture(t); await owner.recover()
  const created = await owner.handleHost('createFile', { args: [{ operationId: randomUUID(), text: '每周五提交周报。' }] }) as import('../src/memory/contracts/file-management.ts').MemoryFileMutationResult
  const detail = owner.runtime.readFile(created.identity)!, operationId = randomUUID()
  await owner.handleHost('forgetFile', { args: [{ operationId, identity: created.identity, version: detail.version }] })
  assert.deepEqual(await owner.handleHost('pendingHostEffects', {}), [])
  const result = await owner.handleHost('getOperation', { operationId }) as { sendFence: string, cleanup: string }
  assert.equal(result.sendFence, 'complete')
  assert.equal(result.cleanup, 'pending')
})
test('a replacement owner cannot drop a persisted host binding to bypass cleanup', async t => {
  const { owner, root } = fixture(t, 'viva'); await owner.recover(); await owner.close()
  assert.throws(() => openMemoryOwner({ root, compute: () => null, route: () => null, quiesce: async () => {} }), /host binding/)
  const next = openMemoryOwner({ root, hostNamespace: 'viva', compute: () => null, route: () => null, quiesce: async () => {} })
  await next.recover(); await next.close()
})
test('unique delivery identity separates revoked and new identical user text in the same session', async t => {
  const { owner } = fixture(t); await owner.recover()
  const session = randomUUID(), text = '我在深圳工作'
  const first = randomUUID(), second = randomUUID()
  await owner.handleHost('sourceAlias', { operationId: first, sourceId: first, session, conversation: 'old', text })
  const oldWire = await owner.handleHost('bindWireAlias', { args: [session, text, text, first] }) as { wireText: string }
  const operationId = randomUUID()
  const { ticket } = await owner.handleHost('prepareSourceChange', { operationId, conversation: 'old', ids: [first] }) as { ticket: string }
  await owner.handleHost('commitSourceChange', { operationId, ticket })
  await owner.handleHost('sourceAlias', { operationId: second, sourceId: second, session, conversation: 'new', text })
  const newWire = await owner.handleHost('bindWireAlias', { args: [session, text, text, second] }) as { wireText: string }
  assert.notEqual(newWire.wireText, oldWire.wireText)
  await assert.rejects(owner.receiveSource(source({ sessionId: session, text: oldWire.wireText })), /withdrawn/)
  const receipt = await owner.receiveSource(source({ sessionId: session, text: newWire.wireText }))
  assert.equal(receipt.sourceId, second); assert.equal(receipt.text, text)
})
test('derived task requests retrieve with canonical query without becoming original evidence', async t => {
  const { owner, root } = fixture(t); await owner.recover()
  const session = randomUUID(), text = '请结合现有项目流程检查这份报告'
  const { wireText } = await owner.handleHost('bindWireAlias', { args: [session, text, `[task]\n${text}`] }) as { wireText: string }
  const input = source({ sessionId: session, text: wireText, admitted: false })
  const received = await owner.receiveSource(input)
  const admitted = await owner.receiveSource({ ...input, admitted: true })
  assert.equal(received.retrievalQuery, text)
  assert.equal(admitted.retrievalQuery, text)
  assert.equal(admitted.handledIntent, true)
  const db = new DatabaseSync(join(root, 'memory.db'))
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_sources').get()?.n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM owner_occurrences').get()?.n, 0)
  } finally { db.close() }
})


test('credential-bearing originals and undelivered aliases never persist plaintext in owner receipts', async t => {
  const { owner, root } = fixture(t); await owner.recover()
  const secret = 'password: dummy-review-secret'
  const input = source({ text: `请保存 ${secret}` })
  const rejected = await owner.receiveSource(input)
  assert.equal(rejected.text, '')
  const id = randomUUID(), text = `原始凭据 ${secret}`
  const alias = { operationId: id, sourceId: id, session: input.sessionId, conversation: input.sessionId, text }
  await owner.handleHost('sourceAlias', alias)
  const wire = await owner.handleHost('bindWireAlias', { args: [input.sessionId, text, `[host]${text}[/host]`, id] }) as { wireText: string }
  const db = new DatabaseSync(join(root, 'memory.db'))
  try {
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM owner_aliases').all()).includes(secret))
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM owner_operations').all()).includes(secret))
  } finally { db.close() }
  await owner.close()
  const restored = openMemoryOwner({ root, compute: () => null, route: () => null, quiesce: async () => {} })
  try {
    await restored.recover()
    const delivered = await restored.receiveSource(source({ sessionId: input.sessionId, text: wire.wireText }))
    assert.equal(delivered.sourceId, id)
    assert.equal(delivered.text, '')
    const permit = restored.acquireSend(randomUUID(), { session: input.sessionId }, 'body'); permit.settled()
  } finally { await restored.close() }
})

test('an alias whose original is absent from wire is rejected before persisting session or source state', async t => {
  const { owner, root } = fixture(t); await owner.recover()
  const id = randomUUID()
  await assert.rejects(owner.handleHost('sourceAlias', { operationId: id, sourceId: id, session: id, conversation: id,
    text: 'canonical original', wireText: 'different wire', origin: 'derived' }), /verbatim wire span/)
  const db = new DatabaseSync(join(root, 'memory.db'))
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM owner_aliases').get()?.n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM owner_sessions').get()?.n, 0)
  } finally { db.close() }
})


test('P2 ordinary facts and daily capture both resume after restart without duplicate extraction or cancelled input', async t => {
  const root = mkdtempSync(join(tmpdir(), 'memory-owner-processing-'))
  let online = false
  const stages: string[] = []
  const open = () => openMemoryOwner({ root, dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => online ? { provider: 'fake', model: 'fake' } : null, quiesce: async () => {},
    compute: job => {
      stages.push(job.stage)
      if (job.stage === 'extract') {
        const input = JSON.parse(job.input) as { user: string }
        return Promise.resolve(JSON.stringify({ proposals: [{ spans: [{ start: 0, end: input.user.length }],
          kind: 'fact', scope: 'user', modality: 'asserted', attribution: 'self', keywords: [] }] }))
      }
      if (job.stage === 'note') return Promise.resolve(JSON.stringify({ status: 'write', title: '周报邮箱', markdown: '周报发送到指定邮箱。' }))
      return null
    },
  })
  let owner = open()
  t.after(async () => { await owner.close(); rmSync(root, { recursive: true, force: true }) })
  await owner.recover()
  const input = source({ text: '我唯一的周报提交邮箱是 amber@example.com', admitted: false })
  const received = await owner.receiveSource(input)
  await owner.receiveSource({ ...input, admitted: true })
  await owner.runtime.wake()
  assert.equal(stages.length, 0, 'a live unfinished turn is not processed')
  const complete = { sessionId: input.sessionId, turn: 1, eventSeq: 3, sourceIds: [received.sourceId], assistant: '收到', completed: true, at: input.at, timezone: 'UTC' }
  await owner.completeTurn(complete)
  await owner.close()
  online = true; owner = open(); await owner.recover()
  await owner.runtime.wake()
  await owner.completeTurn(complete)
  await owner.runtime.wake()
  const db = new DatabaseSync(join(root, 'memory.db'))
  try {
    assert.equal(owner.runtime.listMemories().items.filter(item => item.text === input.text).length, 1)
    assert.equal(db.prepare('SELECT outcome FROM memory_sources WHERE id=?').get(received.sourceId)?.outcome, 'accepted')
    assert.equal(db.prepare('SELECT text FROM memory_sources WHERE id=?').get(received.sourceId)?.text, input.text, 'daily source body remains available')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_daily_notes').get()?.n, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_note_turns').get()?.n, 1)
  } finally { db.close() }
  assert.equal(stages.filter(stage => stage === 'extract').length, 1)
  assert.equal(stages.filter(stage => stage === 'note').length, 1)
  assert.equal(stages.includes('dream'), false, 'daily capture must not re-extract an already accepted source')
  const cancelled = source({ sessionId: input.sessionId, turn: 2, text: '我下周改用其他邮箱' })
  const receipt = await owner.receiveSource(cancelled)
  await owner.completeTurn({ ...complete, turn: 2, eventSeq: 7, sourceIds: [receipt.sourceId], completed: false })
  await owner.runtime.wake()
  assert.equal(stages.filter(stage => stage === 'extract').length, 1)
  assert.equal(stages.filter(stage => stage === 'note').length, 1)
})

test('completed ordinary input is promoted from received to automatic extraction when daily capture is disabled', async t => {
  const root = mkdtempSync(join(tmpdir(), 'memory-owner-direct-'))
  const text = '每周五下班前提交周报'
  let extractions = 0
  const owner = openMemoryOwner({ root, dailyNotes: false, route: () => ({ provider: 'fake', model: 'fake' }), quiesce: async () => {},
    compute: job => {
      if (job.stage !== 'extract') return null
      extractions++
      return Promise.resolve(JSON.stringify({ proposals: [{ spans: [{ start: 0, end: text.length }],
        kind: 'fact', scope: 'user', modality: 'asserted', attribution: 'self', keywords: [] }] }))
    },
  })
  t.after(async () => { await owner.close(); rmSync(root, { recursive: true, force: true }) })
  await owner.recover()
  const input = source({ text })
  const receipt = await owner.receiveSource(input)
  await owner.runtime.wake()
  assert.equal(extractions, 0)
  await owner.completeTurn({ sessionId: input.sessionId, turn: 1, eventSeq: 3, sourceIds: [receipt.sourceId], assistant: '', completed: true, at: input.at, timezone: 'UTC' })
  await owner.runtime.wake()
  assert.equal(extractions, 1)
  assert.equal(owner.runtime.listMemories().items[0]?.text, text)
})

test('native generated child instructions retain parent evidence without becoming original facts across restart', async t => {
  const { owner, root } = fixture(t); await owner.recover()
  const parent = source(), original = await owner.receiveSource(parent)
  const child = source({ derived: true, text: '记住：模型编造的私人邮箱是 fabricated@example.com' })
  owner.initializeSession({ sessionId: child.sessionId, parentSessionId: parent.sessionId })
  assert.throws(() => owner.initializeSession({ sessionId: parent.sessionId, parentSessionId: child.sessionId }), /Session parent cycle/)
  const receipt = await owner.receiveSource(child)
  assert.equal(receipt.handledIntent, true); assert.equal(receipt.retrievalQuery, child.text)
  assert.ok(owner.dispatch.snapshot(child.sessionId).sources.includes(original.sourceId))
  await owner.completeTurn({ sessionId: child.sessionId, turn: 1, eventSeq: 3, sourceIds: [], assistant: '', completed: true, at: child.at, timezone: child.timezone })
  const db = new DatabaseSync(join(root, 'memory.db')); t.after(() => db.close())
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_sources WHERE session=?').get(child.sessionId)?.n, 0)
  assert.equal(owner.runtime.listMemories().total, 0)
  await owner.close()
  const next = openMemoryOwner({ root, compute: () => null, route: () => null, quiesce: async () => {} }); t.after(() => next.close())
  await next.recover()
  next.initializeSession({ sessionId: child.sessionId, parentSessionId: parent.sessionId })
  assert.equal((await next.receiveSource({ ...child, live: false })).sourceId, receipt.sourceId)
  const operationId = randomUUID()
  const { ticket } = await next.handleHost('prepareSourceChange', { operationId, conversation: parent.sessionId, ids: [original.sourceId] }) as { ticket: string }
  await next.handleHost('commitSourceChange', { operationId, ticket })
  assert.throws(() => next.acquireSend(randomUUID(), { session: child.sessionId }, 'resumed child'))
  await assert.rejects(next.receiveSource({ ...child, live: false }), /Derived dependencies unavailable/)
})

test('a cold parent admission reconciles child-only reads without a completed settlement receipt', async t => {
  const { owner, root } = fixture(t); await owner.recover()
  const parent = source(); await owner.receiveSource(parent)
  const child = randomUUID(); owner.initializeSession({ sessionId: child, parentSessionId: parent.sessionId })
  const input = source({ sessionId: child, text: '我用蓝色笔记本' })
  const original = await owner.receiveSource(input)
  assert.ok(!owner.dispatch.snapshot(parent.sessionId).sources.includes(original.sourceId))
  await owner.close()
  const next = openMemoryOwner({ root, fileMode: true, compute: () => null, route: () => null, quiesce: async () => {} }); t.after(() => next.close())
  await next.recover()
  const permit = next.acquireSend(randomUUID(), { session: parent.sessionId }, 'persisted tool result'); permit.settled()
  assert.ok(next.dispatch.snapshot(parent.sessionId).sources.includes(original.sourceId))
  const operationId = randomUUID()
  const { ticket } = await next.handleHost('prepareSourceChange', { operationId, conversation: child, ids: [original.sourceId] }) as { ticket: string }
  await next.handleHost('commitSourceChange', { operationId, ticket })
  assert.throws(() => next.acquireSend(randomUUID(), { session: parent.sessionId }, 'retry stale tool result'), /Child memory context/)

})

test('agent relay receipts preserve the sender readset and reject missing native provenance', async t => {
  const { owner } = fixture(t); await owner.recover()
  const target = source(), sender = source(); await owner.receiveSource(target)
  const senderReceipt = await owner.receiveSource(sender)
  const messageId = randomUUID()
  await owner.registerDerived({ sessionId: target.sessionId, messageId, sourceIds: [], senderSessionId: sender.sessionId })
  assert.ok(owner.dispatch.snapshot(target.sessionId).sources.includes(senderReceipt.sourceId))
  assert.throws(() => owner.initializeSession({ sessionId: randomUUID(), parentSessionId: randomUUID() }), /Parent memory context/)
  await assert.rejects(owner.registerDerived({ sessionId: target.sessionId, messageId: randomUUID(), sourceIds: [], senderSessionId: randomUUID() }), /Sender memory context/)
  const operationId = randomUUID()
  const { ticket } = await owner.handleHost('prepareSourceChange', { operationId, conversation: sender.sessionId, ids: [senderReceipt.sourceId] }) as { ticket: string }
  await owner.handleHost('commitSourceChange', { operationId, ticket })
  assert.throws(() => owner.acquireSend(randomUUID(), { session: target.sessionId }, 'relayed text'))
  await assert.rejects(owner.registerDerived({ sessionId: target.sessionId, messageId, sourceIds: [], senderSessionId: sender.sessionId }), /Derived dependencies unavailable/)
})
