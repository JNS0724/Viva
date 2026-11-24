import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import promises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { removeAbandonedMemoryTemps } from '../src/memory/node/memory-file-store.ts'
import { scratch } from './fixtures/scratch.js'
import { eventually } from './fixtures/eventually.ts'
import type { DiagnosticEvent } from '../src/diagnostics/contracts.ts'
import type { MemoryFileMutationResult } from '../src/memory/contracts/file-management.ts'

function fixture(t: import('node:test').TestContext, hostNamespace?: string, options: Pick<Parameters<typeof openMemoryOwner>[0], 'dailyNotes' | 'diagnostics'> = {}) {
  const { dir: root, defer } = scratch(t, 'memory-owner-')
  const owner = openMemoryOwner({ root, hostNamespace, ...options, compute: () => null, route: () => null })
  defer(() => owner.close())
  return { owner, root, defer }
}
const source = (overrides: Partial<Parameters<ReturnType<typeof openMemoryOwner>['receiveSource']>[0]> = {}) => ({
  sessionId: randomUUID(), messageId: randomUUID(), text: '我在深圳工作', at: Date.now(), timezone: 'Asia/Shanghai', turn: 1, cwd: null, ...overrides,
})

test('owner recovery and close do not wait for a stalled abandoned-temp directory read', { timeout: 15_000 }, async t => {
  const { dir, defer } = scratch(t, 'memory-owner-temps-')
  const root = await promises.realpath(dir)
  const workspace = join(root, 'memory-files', 'a'.repeat(64))
  const digest = join(workspace, 'digest')
  const daily = join(workspace, 'daily')
  mkdirSync(digest, { recursive: true })
  mkdirSync(daily)
  const orphan = join(digest, `.viva-memory-${randomUUID()}.tmp`)
  const unreadable = join(daily, `.viva-memory-${randomUUID()}.tmp`)
  writeFileSync(orphan, 'abandoned file')
  writeFileSync(unreadable, 'unreadable area')

  function gate() {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
  }
  const entered = gate()
  const release = gate()
  const returned = gate()
  const readdir = promises.readdir
  const mocked = t.mock.method(promises, 'readdir', (...args: Parameters<typeof readdir>) => {
    if (args[0] === daily) return Promise.reject(Object.assign(new Error('Unreadable directory'), { code: 'EIO' }))
    if (args[0] !== digest) return Reflect.apply(readdir, promises, args)
    entered.resolve()
    return release.promise.then(() => Reflect.apply(readdir, promises, args)).finally(returned.resolve)
  })
  syncBuiltinESMExports()
  const options = { root, compute: () => null, route: () => null }
  try {
    const owner = openMemoryOwner(options)
    defer(() => owner.close())
    await Promise.all([owner.recover(), entered.promise])
    assert.equal(owner.ready(), true)
    assert.equal(existsSync(orphan), true)
    await owner.close()
    release.resolve()
    await returned.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(existsSync(orphan), true, 'the closed owner cannot proceed to unlink')
  } finally {
    release.resolve()
    mocked.mock.restore()
    syncBuiltinESMExports()
  }

  const replacement = openMemoryOwner(options)
  defer(() => replacement.close())
  await replacement.recover()
  assert.equal(await eventually(() => !existsSync(orphan) && !existsSync(unreadable)), true)
})

test('abandoned-temp cleanup only touches strict names in managed directories', async t => {
  const { dir } = scratch(t, 'memory-owner-temp-paths-')
  const root = join(realpathSync(dir), 'memory-files')
  const workspace = join(root, 'a'.repeat(64))
  const outside = join(dir, 'outside')
  const digest = join(workspace, 'digest')
  const hidden = join(digest, '.private')
  const unmanaged = join(workspace, 'unmanaged')
  for (const directory of [outside, hidden, unmanaged]) mkdirSync(directory, { recursive: true })
  symlinkSync(outside, join(workspace, 'daily'), 'junction')
  symlinkSync(outside, join(digest, 'foreign'), 'junction')
  const temp = `.viva-memory-${randomUUID()}.tmp`
  const removed = join(digest, temp)
  const preserved = [outside, hidden, unmanaged].map(directory => join(directory, temp))
  preserved.push(join(digest, '.viva-memory-invalid.tmp'))
  for (const file of [removed, ...preserved]) writeFileSync(file, 'fixture')
  await removeAbandonedMemoryTemps(root, new AbortController().signal)
  assert.equal(existsSync(removed), false)
  for (const file of preserved) assert.equal(existsSync(file), true, file)
})




test('owner diagnostics preserve durable write, replay, undo and local deletion receipts without copying memory text', async t => {
  const events: DiagnosticEvent[] = []
  const { owner } = fixture(t, 'viva', { diagnostics: { emit(event) { events.push(event); return undefined } } })
  await owner.recover()
  const create = { operationId: randomUUID(), text: 'PRIVATE_MEMORY_BODY 提交周报。', title: 'PRIVATE_MEMORY_TITLE' }
  const first = await owner.handleHost('createFile', { args: [create] }) as MemoryFileMutationResult
  assert.deepEqual(await owner.handleHost('createFile', { args: [create] }), first)
  assert.equal(events.filter(event => event.stage === 'applied' && event.identities?.requestId === create.operationId).length, 1)
  assert.ok(events.some(event => event.reason === 'idempotent' && event.identities?.requestId === create.operationId))
  const detail = owner.runtime.readFile(first.identity)!
  const edit = { operationId: randomUUID(), identity: first.identity, version: detail.version, text: 'PRIVATE_REPLACEMENT_BODY 改成周一。' }
  await owner.handleHost('editFile', { args: [edit] })
  const edited = owner.runtime.readFile(first.identity)!
  const undo = { operationId: randomUUID(), identity: first.identity, version: edited.version, changeId: edit.operationId }
  await owner.handleHost('undoFile', { args: [undo] })
  assert.ok(events.some(event => event.operation === 'memory.undo' && event.stage === 'applied' && event.identities?.requestId === undo.operationId))
  const failed = { ...edit, operationId: randomUUID() }
  await assert.rejects(owner.handleHost('editFile', { args: [failed] }), { code: 'revision.conflict' })
  assert.equal(events.some(event => event.stage === 'applied' && event.identities?.requestId === failed.operationId), false)
  const restored = owner.runtime.readFile(first.identity)!
  const forget = { operationId: randomUUID(), identity: first.identity, version: restored.version }
  await owner.handleHost('forgetFile', { args: [forget] })
  assert.ok(events.some(event => event.operation === 'memory.forget' && event.stage === 'applied' && event.identities?.requestId === forget.operationId))
  await owner.runtime.wake()
  assert.equal((await owner.handleHost('getOperation', { operationId: forget.operationId }) as { cleanup: string }).cleanup, 'complete')
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_MEMORY_BODY|PRIVATE_MEMORY_TITLE|PRIVATE_REPLACEMENT_BODY/)
})

test('a throwing owner observer cannot change source intake, write receipts or the real validation failure', async t => {
  const { owner } = fixture(t, undefined, { diagnostics: { emit() { throw new Error('broken observer') } } })
  await owner.recover()
  const input = source()
  assert.ok((await owner.receiveSource(input)).sourceId)
  const create = { operationId: randomUUID(), text: '每周五提交周报。' }
  const first = await owner.handleHost('createFile', { args: [create] }) as MemoryFileMutationResult
  assert.deepEqual(await owner.handleHost('createFile', { args: [create] }), first)
  const detail = owner.runtime.readFile(first.identity)!
  await assert.rejects(owner.handleHost('editFile', { args: [{ operationId: randomUUID(), identity: first.identity,
    version: { ...detail.version, contentRevision: 'stale' }, text: '改成周一。' }] }), { code: 'revision.conflict' })
})



test('owner refuses a second process-local connection and can reopen after close', async t => {
  const { owner, root, defer } = fixture(t)
  assert.throws(() => openMemoryOwner({ root, compute: () => null, route: () => null }), /active owner/)
  await owner.close()
  const next = openMemoryOwner({ root, compute: () => null, route: () => null })
  defer(() => next.close())
  await next.recover(); await next.close()
})
test('received original is durable before automatic processing, cancellation keeps it unprocessed', async t => {
  const { owner, root, defer } = fixture(t)
  await owner.recover()
  const input = source()
  const receipt = await owner.receiveSource(input)
  const db = new DatabaseSync(join(root, 'memory.db')); defer(() => db.close())
  assert.equal(db.prepare('SELECT outcome FROM memory_sources WHERE id=?').get(receipt.sourceId)?.outcome, 'received')
  await owner.completeTurn({ sessionId: input.sessionId, turn: 1, eventSeq: 3, sourceIds: [receipt.sourceId], assistant: '', completed: false, at: input.at, timezone: input.timezone })
  assert.equal(db.prepare('SELECT outcome FROM memory_sources WHERE id=?').get(receipt.sourceId)?.outcome, 'received')
  assert.equal(owner.runtime.listFiles({ kind: 'digest' }).items.length, 0)
})
test('completion promotes source once and keeps original capture time', async t => {
  const { owner, root, defer } = fixture(t); await owner.recover()
  const input = source({ at: 1730000000000 })
  const receipt = await owner.receiveSource(input)
  const complete = { sessionId: input.sessionId, turn: 1, eventSeq: 3, sourceIds: [receipt.sourceId], assistant: '收到', completed: true, at: input.at, timezone: input.timezone }
  await owner.completeTurn(complete); await owner.completeTurn(complete)
  const db = new DatabaseSync(join(root, 'memory.db')); defer(() => db.close())
  const row = db.prepare('SELECT outcome,at FROM memory_sources WHERE id=?').get(receipt.sourceId)
  assert.equal(row?.outcome, 'note-pending'); assert.equal(row?.at, input.at)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM owner_turns').get()?.n, 1)
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
  const next = openMemoryOwner({ root, compute: () => null, route: () => null })
  try { await next.recover(); assert.equal(next.ready(), true) } finally { await next.close() }
})



test('custom question answer uses the owner native turn and joins only completed-turn processing', async t => {
  const { owner, root } = fixture(t); await owner.recover()
  const original = source({ turn: 2 })
  await owner.receiveSource(original)
  const card = { id: 'drink', question: '你喜欢什么饮品？', header: '', multiSelect: false, options: [{ label: '茶' }] }
  const context = { kind: 'conversation' as const, id: original.sessionId }
  // The verified question from turn 3 can be answered before the sidecar
  // receives turn 3 or finishes replaying turn 2.
  const operationId = randomUUID()
  const answer = { operationId, session: original.sessionId, conversation: original.sessionId, text: '我喜欢茉莉花茶', turn: 3, cards: [card],
    requestId: 'request', questionId: card.id, context }
  assert.deepEqual(await owner.handleHost('acceptQuestionAnswer', answer), { sourceId: operationId })
  assert.deepEqual(await owner.handleHost('acceptQuestionAnswer', answer), { sourceId: operationId })
  await owner.completeTurn({ sessionId: original.sessionId, turn: 2, eventSeq: 5, sourceIds: [original.messageId], assistant: '', completed: true,
    at: Date.now(), timezone: 'Asia/Shanghai' })
  await owner.completeTurn({ sessionId: original.sessionId, turn: 3, eventSeq: 10, sourceIds: [], assistant: '收到', completed: true, at: Date.now(), timezone: 'Asia/Shanghai' })
  const db = new DatabaseSync(join(root, 'memory.db'))
  try { assert.equal(db.prepare('SELECT outcome FROM memory_sources WHERE id=?').get(operationId)?.outcome, 'note-pending') } finally { db.close() }
})


test('an independent owner completes file deletion without a native or host cleanup participant', async t => {
  const { owner } = fixture(t); await owner.recover()
  const created = await owner.handleHost('createFile', { args: [{ operationId: randomUUID(), text: '每周五提交周报。' }] }) as import('../src/memory/contracts/file-management.ts').MemoryFileMutationResult
  const detail = owner.runtime.readFile(created.identity)!, operationId = randomUUID()
  await owner.handleHost('forgetFile', { args: [{ operationId, identity: created.identity, version: detail.version }] })
  await owner.runtime.wake()
  const result = await owner.handleHost('getOperation', { operationId }) as { cleanup: string }
  assert.equal(result.cleanup, 'complete')
})
test('a replacement owner cannot drop a persisted host binding to bypass cleanup', async t => {
  const { owner, root, defer } = fixture(t, 'viva'); await owner.recover(); await owner.close()
  assert.throws(() => openMemoryOwner({ root, compute: () => null, route: () => null }), /host binding/)
  const next = openMemoryOwner({ root, hostNamespace: 'viva', compute: () => null, route: () => null })
  defer(() => next.close())
  await next.recover(); await next.close()
})




test('credential-bearing originals and undelivered aliases never persist plaintext in owner receipts', async t => {
  const { owner, root } = fixture(t); await owner.recover()
  const secret = 'password: dummy-review-secret'
  const input = source({ text: `请保存 ${secret}` })
  const rejected = await owner.receiveSource(input)
  assert.equal(rejected.text, '')
  const id = randomUUID(), text = `原始凭据 ${secret}`
  const alias = { operationId: id, sourceId: id, session: input.sessionId, conversation: input.sessionId, text, wireText: `[host]${text}[/host]`, cwd: null }
  await owner.handleHost('sourceAlias', alias)
  const db = new DatabaseSync(join(root, 'memory.db'))
  try {
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM owner_aliases').all()).includes(secret))
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM owner_operations').all()).includes(secret))
  } finally { db.close() }
  await owner.close()
  const restored = openMemoryOwner({ root, compute: () => null, route: () => null })
  try {
    await restored.recover()
    const delivered = await restored.receiveSource(source({ sessionId: input.sessionId, text: alias.wireText }))
    assert.equal(delivered.sourceId, id)
    assert.equal(delivered.text, '')
  } finally { await restored.close() }
})

test('an alias whose original is absent from wire is rejected before persisting session or source state', async t => {
  const { owner, root } = fixture(t); await owner.recover()
  const id = randomUUID()
  await assert.rejects(owner.handleHost('sourceAlias', { operationId: id, sourceId: id, session: id, conversation: id,
    text: 'canonical original', wireText: 'different wire', cwd: null, origin: 'derived' }), /verbatim wire span/)
  const db = new DatabaseSync(join(root, 'memory.db'))
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM owner_aliases').get()?.n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM owner_sessions').get()?.n, 0)
  } finally { db.close() }
})


test('completed daily capture resumes after restart without duplicate notes or cancelled input', async t => {
  const { dir: root, defer } = scratch(t, 'memory-owner-processing-')
  let online = false
  const stages: string[] = []
  const open = () => openMemoryOwner({ root, dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => online ? { provider: 'fake', model: 'fake' } : null,
    compute: job => {
      stages.push(job.stage)
      if (job.stage === 'note') return Promise.resolve(JSON.stringify({ status: 'write', title: '周报邮箱', markdown: '周报发送到指定邮箱。' }))
      return null
    },
  })
  let owner = open()
  defer(() => owner.close())
  await owner.recover()
  const input = source({ text: '我唯一的周报提交邮箱是 amber@example.com' })
  const received = await owner.receiveSource(input)
  await owner.receiveSource(input)
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
    assert.equal(owner.runtime.listFiles({ kind: 'digest' }).items.length, 0)
    assert.equal(db.prepare('SELECT outcome FROM memory_sources WHERE id=?').get(received.sourceId)?.outcome, 'note-ready')
    assert.equal(db.prepare('SELECT text FROM memory_sources WHERE id=?').get(received.sourceId)?.text, input.text, 'daily source body remains available')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_daily_notes').get()?.n, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_note_turns').get()?.n, 1)
  } finally { db.close() }
  assert.equal(stages.filter(stage => stage === 'extract').length, 0)
  assert.equal(stages.filter(stage => stage === 'note').length, 1)
  assert.equal(stages.includes('dream'), false, 'capturing a note does not schedule an unrelated dream run')
  const cancelled = source({ sessionId: input.sessionId, turn: 2, text: '我下周改用其他邮箱' })
  const receipt = await owner.receiveSource(cancelled)
  await owner.completeTurn({ ...complete, turn: 2, eventSeq: 7, sourceIds: [receipt.sourceId], completed: false })
  await owner.runtime.wake()
  assert.equal(stages.filter(stage => stage === 'extract').length, 0)
  assert.equal(stages.filter(stage => stage === 'note').length, 1)
})

test('a Git identity change within a turn never mixes note scope or stalls the durable cursor', async t => {
  const { owner, root } = fixture(t)
  await owner.recover()
  const cwd = join(root, 'project'), git = join(cwd, '.git')
  mkdirSync(join(git, 'objects'), { recursive: true })
  writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n')
  const original = source({ cwd, text: 'A verified project planning note.' })
  const received = await owner.receiveSource(original)
  rmSync(git, { recursive: true })
  const reply = await owner.receiveSource(source({ cwd, sessionId: original.sessionId, text: 'An unverified interjection.' }))
  assert.equal(reply.text, '')
  await owner.completeTurn({ sessionId: original.sessionId, turn: 1, eventSeq: 4, sourceIds: [received.sourceId],
    assistant: 'A response to the unverified interjection.', completed: true, at: original.at, timezone: original.timezone })
  assert.equal(owner.intakeWatermark(original.sessionId).nextSeq, 5)
  const db = new DatabaseSync(join(root, 'memory.db'), { readOnly: true })
  try {
    const sources = db.prepare('SELECT session, project, text FROM memory_sources').all()
    assert.equal(sources.length, 1)
    assert.equal(sources[0]?.text, original.text)
    assert.ok(sources[0]?.project)
    assert.equal(db.prepare('SELECT assistant_digest FROM memory_note_turns WHERE session=?').get(original.sessionId)?.assistant_digest, null)
  } finally { db.close() }
})

test('completed ordinary input stays canonical when daily capture is disabled', async t => {
  const { owner, root, defer } = fixture(t, undefined, { dailyNotes: false })
  await owner.recover()
  const input = source({ text: '每周五下班前提交周报' })
  const receipt = await owner.receiveSource(input)
  await owner.completeTurn({ sessionId: input.sessionId, turn: 1, eventSeq: 3, sourceIds: [receipt.sourceId], assistant: '', completed: true, at: input.at, timezone: 'UTC' })
  await owner.runtime.wake()
  const db = new DatabaseSync(join(root, 'memory.db')); defer(() => db.close())
  assert.equal(db.prepare('SELECT outcome FROM memory_sources WHERE id=?').get(receipt.sourceId)?.outcome, 'recorded')
  assert.equal(owner.runtime.sourceCurrent(receipt.sourceId), true)
  assert.equal(owner.runtime.listFiles({ kind: 'daily' }).items.length, 0)
  assert.equal(owner.runtime.listFiles({ kind: 'digest' }).items.length, 0)
})
