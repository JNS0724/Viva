import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scratch } from './fixtures/scratch.js'
import { openMemoryOwner } from '../src/memory/node/owner.ts'

const signal = new AbortController().signal

test('standalone explicit file commands use the native session scope, versions and durable owner receipts', async t => {
  const { dir, defer } = scratch(t, 'viva-memory-commands-')
  const cwd = (name: string) => {
    const workspace = join(dir, name), git = join(workspace, '.git')
    mkdirSync(join(git, 'objects'), { recursive: true })
    writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n')
    return workspace
  }
  const options = { root: join(dir, 'memory'), compute: () => null, route: () => null }
  let owner = openMemoryOwner(options)
  defer(() => owner.close())
  await owner.recover()
  const session = 'project-one', neighbor = 'project-two', personal = 'personal'
  owner.bindIntakeSession(session, cwd('one'))
  owner.bindIntakeSession(neighbor, cwd('two'))
  owner.bindIntakeSession(personal, dir)
  const method = (current: string, id: string) => owner.runtime.handle({ op: 'file_read', session: current, id }, owner.sessionContext(current))
  const input = { operationId: randomUUID(), text: 'Project-only release notes stay with the rollout.' }
  const written = await owner.rememberStandaloneFile(session, input)
  assert.deepEqual(await owner.rememberStandaloneFile(session, input), written)
  await assert.rejects(owner.rememberStandaloneFile(neighbor, input), { code: 'operation.conflict' })
  assert.throws(() => owner.rememberStandaloneFile('unregistered', { ...input, operationId: randomUUID() }), { code: 'not.found' })
  assert.ok(method(session, written.identity.id).includes(input.text))
  assert.ok(!method(personal, written.identity.id).includes(input.text))
  const db = new DatabaseSync(join(options.root, 'memory.db'))
  defer(() => db.close())
  assert.deepEqual(JSON.parse(String(db.prepare('SELECT context FROM memory_sources WHERE id=?').get(input.operationId)?.context)),
    owner.sessionContext(session).context, 'manual and native foreground files share the authenticated default scope')
  await assert.rejects(owner.forgetStandaloneFile(neighbor, written.identity.id, randomUUID()), { code: 'not.found' })
  assert.ok(owner.runtime.readFile(written.identity))
  const operationId = randomUUID()
  const cleanup = await owner.forgetStandaloneFile(session, written.identity.id, operationId)
  assert.ok(cleanup === 'pending' || cleanup === 'complete')
  assert.equal(owner.runtime.readFile(written.identity), null)
  await owner.close()
  owner = openMemoryOwner(options)
  await owner.recover()
  const retry = await owner.forgetStandaloneFile(session, written.identity.id, operationId)
  assert.equal(retry, 'complete')
  await assert.rejects(owner.forgetStandaloneFile(neighbor, written.identity.id, operationId), { code: 'operation.conflict' })
  assert.equal(owner.runtime.readFile(written.identity), null)
})

test('native remember binds the active canonical span and replay identity without a numeric fact', async t => {
  const { dir, defer } = scratch(t, 'viva-native-remember-')
  const options = { root: dir, compute: () => null, route: () => null }
  let owner = openMemoryOwner(options)
  defer(() => owner.close())
  await owner.recover()
  const session = randomUUID(), sourceId = randomUUID(), text = '每周五提交周报，客户故障时另行确认。', original = `记住：${text}`
  owner.stageOpenTurnSources({
    sessionId: session, turn: 1, sessionKind: 'main', cwd: null,
    sources: [{ sourceId, author: 'user', sourceKind: 'main-human', profileEligible: true, text: original, at: Date.now(), timezone: 'UTC' }],
  })
  const write = () => owner.rememberSidecarFile(session, text, signal)
  assert.equal(await owner.rememberSidecarFile('unregistered', text, signal), null, 'a caller outside the current turn has no write authority')
  assert.equal(await owner.rememberSidecarFile(session, '模型改写的无原文事实', signal), null)
  const first = await write()
  assert.ok(first)
  assert.deepEqual(await owner.rememberSidecarFile(session, text, signal), first, 'the durable native event survives a new process-local lease ID')
  assert.equal(owner.runtime.listFiles({ kind: 'digest' }).items.length, 1)
  const detail = owner.runtime.readFile(first.identity)!
  assert.ok(detail.markdown.includes(text))
  assert.deepEqual(detail.sources.map(source => source.sourceId), [sourceId])
  await owner.handleHost('setFileEnabled', { args: [{ operationId: randomUUID(), identity: first.identity, version: detail.version, enabled: false }] })
  const stopped = owner.runtime.readFile(first.identity)!
  assert.deepEqual(await write(), first, 'replaying a completed write returns its receipt without re-enabling the file')
  assert.equal(owner.runtime.readFile(first.identity)?.enabled, false)
  await owner.handleHost('setFileEnabled', { args: [{ operationId: randomUUID(), identity: first.identity, version: stopped.version, enabled: true }] })
  const currentDetail = owner.runtime.readFile(first.identity)!
  await owner.handleHost('forgetFile', { args: [{ operationId: randomUUID(), identity: first.identity, version: currentDetail.version }] })
  assert.deepEqual(await write(), first, 'replaying a completed call returns its original receipt')
  assert.equal(owner.runtime.readFile(first.identity), null, 'replay cannot recreate the deleted file')
  assert.equal(owner.runtime.sourceCurrent(sourceId), true, 'the original user request remains available')
  const independent = randomUUID()
  owner.stageOpenTurnSources({
    sessionId: session, turn: 2, sessionKind: 'main', cwd: null,
    sources: [{ sourceId: independent, author: 'user', sourceKind: 'main-human', profileEligible: true, text: original, at: Date.now(), timezone: 'UTC' }],
  })
  const fresh = await owner.rememberSidecarFile(session, text, signal)
  assert.ok(fresh)
  assert.notEqual(fresh.identity.id, first.identity.id)
  assert.equal(owner.runtime.readFile(first.identity), null)
  await owner.close()
  owner = openMemoryOwner(options)
  await owner.recover()
  assert.equal(owner.runtime.readFile(first.identity), null)
})


test('native remember recovers the same file after publication precedes the owner receipt', async t => {
  const { dir, defer } = scratch(t, 'viva-native-remember-receipt-')
  const options = { root: dir, compute: () => null, route: () => null }
  let owner = openMemoryOwner(options)
  defer(() => owner.close())
  await owner.recover()
  const session = randomUUID(), sourceId = randomUUID(), text = '保留提交周报的条件和例外。'
  owner.stageOpenTurnSources({
    sessionId: session, turn: 1, sessionKind: 'main', cwd: null,
    sources: [{ sourceId, author: 'user', sourceKind: 'main-human', profileEligible: true, text: `记住：${text}`, at: Date.now(), timezone: 'UTC' }],
  })
  const db = new DatabaseSync(join(dir, 'memory.db'))
  defer(() => db.close())
  db.exec(`CREATE TRIGGER lose_native_write_receipt BEFORE UPDATE OF state ON owner_operations
    WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'injected receipt interruption'); END`)
  await assert.rejects(owner.rememberSidecarFile(session, text, signal), /receipt interruption/)
  const before = owner.runtime.listFiles({ kind: 'digest' }).items
  assert.equal(before.length, 1)
  const pending = db.prepare("SELECT payload FROM owner_operations WHERE state='running'").all()
  assert.equal(pending.length, 1)
  assert.ok(!JSON.stringify(pending).includes(text))
  db.exec('DROP TRIGGER lose_native_write_receipt')
  await owner.close()
  owner = openMemoryOwner(options)
  await owner.recover()
  assert.equal(db.prepare("SELECT count(*) AS n FROM owner_operations WHERE state='running'").get()?.n, 0)
  assert.deepEqual(owner.runtime.listFiles({ kind: 'digest' }).items.map(item => item.identity), before.map(item => item.identity))
  assert.ok(owner.runtime.readFile(before[0]!.identity)?.markdown.includes(text))
})

test('native remember cannot use an older explicit request replayed before a new turn', async t => {
  const { dir, defer } = scratch(t, 'viva-native-remember-turn-')
  const options = { root: dir, compute: () => null, route: () => null }
  let owner = openMemoryOwner(options)
  defer(() => owner.close())
  await owner.recover()
  const session = randomUUID(), text = '每周五提交周报。', at = Date.now()
  const turn1Source = randomUUID()
  owner.stageOpenTurnSources({
    sessionId: session, turn: 1, sessionKind: 'main', cwd: null,
    sources: [{ sourceId: turn1Source, author: 'user', sourceKind: 'main-human', profileEligible: true, text: `记住：${text}`, at, timezone: 'UTC' }],
  })
  const done = {
    sessionId: session, cwd: null, sessionKind: 'main' as const, inheritedSeq: 0,
    expectedNextSeq: null, fromSeq: 0, toSeq: 5, turn: 1, reasonKind: 'completed',
    sources: [{ sourceId: turn1Source, author: 'user' as const, sourceKind: 'main-human' as const, profileEligible: true, text: `记住：${text}`, at, timezone: 'UTC' }],
    assistantText: '', at, timezone: 'UTC',
  }
  await owner.settleTurn(done)
  await owner.close()
  owner = openMemoryOwner(options)
  await owner.recover()
  // Replaying turn 1 settles idempotently and never re-opens turn 1 staging.
  await owner.settleTurn(done)
  owner.stageOpenTurnSources({
    sessionId: session, turn: 2, sessionKind: 'main', cwd: null,
    sources: [{ sourceId: randomUUID(), author: 'user', sourceKind: 'main-human', profileEligible: true, text: '继续讨论周报。', at, timezone: 'UTC' }],
  })
  assert.equal(await owner.rememberSidecarFile(session, text, signal), null)
  const turn2Source = randomUUID()
  owner.stageOpenTurnSources({
    sessionId: session, turn: 2, sessionKind: 'main', cwd: null,
    sources: [{ sourceId: turn2Source, author: 'user', sourceKind: 'main-human', profileEligible: true, text: `记住：${text}`, at, timezone: 'UTC' }],
  })
  const saved = await owner.rememberSidecarFile(session, text, signal)
  assert.ok(saved)
  assert.deepEqual(owner.runtime.readFile(saved.identity)?.sources.map(source => source.sourceId), [turn2Source])
})

test('native remember accepts arbitrary current-turn original fragments without a command prefix', async t => {
  const { dir, defer } = scratch(t, 'viva-native-remember-fragments-')
  const owner = openMemoryOwner({ root: dir, compute: () => null, route: () => null })
  defer(() => owner.close())
  await owner.recover()
  const session = randomUUID()
  const examples = [
    { original: '记住我在深圳', text: '我在深圳' },
    { original: '补充一下，我周五交周报，客户故障时另行确认。请以后保留这个安排。', text: '我周五交周报，客户故障时另行确认。' },
    { original: 'For future chats, keep this preference in mind. I write in Spanish.', text: 'I write in Spanish.' },
  ]
  for (const [index, example] of examples.entries()) {
    const sourceId = randomUUID()
    owner.stageOpenTurnSources({
      sessionId: session, turn: index + 1, sessionKind: 'main', cwd: null,
      sources: [{ sourceId, author: 'user', sourceKind: 'main-human', profileEligible: true, text: example.original, at: Date.now(), timezone: 'UTC' }],
    })
    const saved = await owner.rememberSidecarFile(session, example.text, signal)
    assert.ok(saved)
    assert.ok(owner.runtime.readFile(saved.identity)?.markdown.includes(example.text))
  }
})
