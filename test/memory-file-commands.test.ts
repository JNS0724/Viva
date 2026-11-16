import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scratch } from './fixtures/scratch.js'
import { openMemoryOwner } from '../src/memory/node/owner.ts'

test('standalone explicit file commands use the native session scope, versions and durable owner receipts', async t => {
  const { dir, defer } = scratch(t, 'viva-memory-commands-')
  const cwd = (name: string) => {
    const workspace = join(dir, name), git = join(workspace, '.git')
    mkdirSync(join(git, 'objects'), { recursive: true })
    writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n')
    return workspace
  }
  const options = { root: join(dir, 'memory'), compute: () => null, route: () => null, quiesce: async () => {} }
  let owner = openMemoryOwner(options)
  defer(() => owner.close())
  await owner.recover()
  const session = 'project-one', neighbor = 'project-two', personal = 'personal'
  owner.initializeSession({ sessionId: session, cwd: cwd('one') })
  owner.initializeSession({ sessionId: neighbor, cwd: cwd('two') })
  owner.initializeSession({ sessionId: personal, cwd: dir })
  const method = (current: string, id: string) => owner.runtime.handle({ op: 'file_read', session: current, id }, owner.sessionContext(current))
  const input = { operationId: randomUUID(), text: 'Project-only release notes stay with the rollout.' }
  const written = await owner.rememberStandaloneFile(session, input)
  assert.deepEqual(await owner.rememberStandaloneFile(session, input), written)
  await assert.rejects(owner.rememberStandaloneFile(neighbor, input), { code: 'operation.conflict' })
  assert.throws(() => owner.rememberStandaloneFile('unregistered', { ...input, operationId: randomUUID() }), { code: 'not.found' })
  assert.ok(method(session, written.identity.id).includes(input.text))
  assert.ok(!method(personal, written.identity.id).includes(input.text))
  await assert.rejects(owner.forgetStandaloneFile(neighbor, written.identity.id, randomUUID()), { code: 'not.found' })
  assert.ok(owner.runtime.readFile(written.identity))
  const operationId = randomUUID()
  assert.equal(await owner.forgetStandaloneFile(session, written.identity.id, operationId), 'pending')
  assert.equal(owner.runtime.readFile(written.identity), null)
  await owner.close()
  owner = openMemoryOwner(options)
  await owner.recover()
  const retry = await owner.forgetStandaloneFile(session, written.identity.id, operationId)
  assert.ok(retry === 'pending' || retry === 'complete')
  await assert.rejects(owner.forgetStandaloneFile(neighbor, written.identity.id, operationId), { code: 'operation.conflict' })
  assert.equal(owner.runtime.readFile(written.identity), null)
})

test('native remember binds the active canonical span and replay identity without a numeric fact', async t => {
  const { dir, defer } = scratch(t, 'viva-native-remember-')
  const options = { root: dir, compute: () => null, route: () => null, quiesce: async () => {} }
  let owner = openMemoryOwner(options)
  defer(() => owner.close())
  await owner.recover()
  const session = randomUUID(), sourceId = randomUUID(), text = '每周五提交周报，客户故障时另行确认。', original = `记住：${text}`
  await owner.receiveSource({ sessionId: session, messageId: sourceId, text: original, turn: 1, step: 1,
    at: Date.now(), timezone: 'UTC', admitted: true, inherited: false })
  const call = { id: randomUUID(), session, generation: 0, callId: 'native-write', turn: 1, step: 1, seq: 3, digest: '1'.repeat(64) }
  const write = () => owner.withNativeToolRead({ call, calls: [call], current: () => true }, () => owner.rememberNativeFile(text))
  assert.equal(await owner.rememberNativeFile(text), null, 'a caller without a native lease has no write authority')
  assert.equal(await owner.withNativeToolRead({ call, calls: [call], current: () => true }, () => owner.rememberNativeFile('模型改写的无原文事实')), null)
  const first = await write()
  assert.ok(first)
  const proof = owner.dispatch.snapshot(session).files?.find(file => file.id === first.identity.id)
  assert.deepEqual(proof?.sourceRanges, [{ sourceId, spans: [{ start: 3, end: original.length }] }])
  const replayedCall = { ...call, id: randomUUID() }
  assert.deepEqual(await owner.withNativeToolRead({ call: replayedCall, calls: [replayedCall], current: () => true },
    () => owner.rememberNativeFile(text)), first, 'the durable native event survives a new process-local lease ID')
  assert.equal(owner.runtime.listFiles({ kind: 'digest' }).items.length, 1)
  const detail = owner.runtime.readFile(first.identity)!
  assert.ok(detail.markdown.includes(text))
  await owner.handleHost('setFileEnabled', { args: [{ operationId: randomUUID(), identity: first.identity, version: detail.version, enabled: false }] })
  const stopped = owner.runtime.readFile(first.identity)!
  assert.equal(await write(), null, 'the same canonical span cannot bypass a stop through an explicit tool')
  await owner.handleHost('setFileEnabled', { args: [{ operationId: randomUUID(), identity: first.identity, version: stopped.version, enabled: true }] })
  const currentDetail = owner.runtime.readFile(first.identity)!
  await owner.handleHost('forgetFile', { args: [{ operationId: randomUUID(), identity: first.identity, version: currentDetail.version }] })
  assert.equal(await write(), null, 'an old call cannot resurrect erased canonical evidence')
  const independent = randomUUID()
  await owner.receiveSource({ sessionId: session, messageId: independent, text: original, turn: 1, step: 2,
    at: Date.now(), timezone: 'UTC', admitted: true, inherited: false })
  const nextCall = { ...call, id: randomUUID(), callId: 'independent-write', seq: 5, digest: '4'.repeat(64), step: 2 }
  const fresh = await owner.withNativeToolRead({ call: nextCall, calls: [nextCall], current: () => true }, () => owner.rememberNativeFile(text))
  assert.ok(fresh)
  assert.notEqual(fresh.identity.id, first.identity.id)
  assert.equal(owner.runtime.readFile(first.identity), null)
  await owner.close()
  owner = openMemoryOwner(options)
  await owner.recover()
  assert.equal(owner.runtime.readFile(first.identity), null)
})

test('native remember rejects derived input and an execution retired while waiting for the write fence', async t => {
  const { dir, defer } = scratch(t, 'viva-native-remember-fence-')
  const owner = openMemoryOwner({ root: dir, compute: () => null, route: () => null, quiesce: async () => {} })
  defer(() => owner.close())
  await owner.recover()
  const session = randomUUID(), text = '每周五提交周报。'
  const call = { id: randomUUID(), session, generation: 0, callId: 'native-write', turn: 1, step: 1, seq: 3, digest: '2'.repeat(64) }
  await owner.receiveSource({ sessionId: session, messageId: randomUUID(), text: `记住：${text}`, derived: true,
    turn: 1, step: 1, at: Date.now(), timezone: 'UTC', admitted: true, inherited: false })
  assert.equal(await owner.withNativeToolRead({ call, calls: [call], current: () => true }, () => owner.rememberNativeFile(text)), null)
  await owner.receiveSource({ sessionId: session, messageId: randomUUID(), text: `记住：${text}`,
    turn: 1, step: 1, at: Date.now(), timezone: 'UTC', admitted: true, inherited: false })
  const permit = owner.acquireSend(randomUUID(), { session }, 'physical request')
  let current = true
  const pending = owner.withNativeToolRead({ call, calls: [call], current: () => current }, () => owner.rememberNativeFile(text))
  await new Promise<void>(resolve => setImmediate(resolve))
  current = false
  permit.settled()
  await assert.rejects(pending, { code: 'not.found' })
  assert.equal(owner.runtime.listFiles({}).items.length, 0)
})

test('native remember recovers the same file after publication precedes the owner receipt', async t => {
  const { dir, defer } = scratch(t, 'viva-native-remember-receipt-')
  const options = { root: dir, compute: () => null, route: () => null, quiesce: async () => {} }
  let owner = openMemoryOwner(options)
  defer(() => owner.close())
  await owner.recover()
  const session = randomUUID(), sourceId = randomUUID(), text = '保留提交周报的条件和例外。'
  await owner.receiveSource({ sessionId: session, messageId: sourceId, text: `记住：${text}`,
    turn: 1, step: 1, at: Date.now(), timezone: 'UTC', admitted: true, inherited: false })
  const db = new DatabaseSync(join(dir, 'memory.db'))
  defer(() => db.close())
  db.exec(`CREATE TRIGGER lose_native_write_receipt BEFORE UPDATE OF state ON owner_operations
    WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'injected receipt interruption'); END`)
  const call = { id: randomUUID(), session, generation: 0, callId: 'native-write', turn: 1, step: 1, seq: 3, digest: '3'.repeat(64) }
  await assert.rejects(owner.withNativeToolRead({ call, calls: [call], current: () => true }, () => owner.rememberNativeFile(text)), /receipt interruption/)
  const before = owner.runtime.listFiles({ kind: 'digest' }).items
  assert.equal(before.length, 1)
  assert.equal(db.prepare('SELECT count(*) AS n FROM owner_native_tool_reads WHERE call=?').get(call.id)?.n, 1)
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
  const options = { root: dir, compute: () => null, route: () => null, quiesce: async () => {} }
  let owner = openMemoryOwner(options)
  defer(() => owner.close())
  await owner.recover()
  const session = randomUUID(), text = '每周五提交周报。'
  const original = { sessionId: session, messageId: randomUUID(), text: `记住：${text}`, turn: 1, step: 1,
    at: Date.now(), timezone: 'UTC', admitted: true, inherited: false }
  const receipt = await owner.receiveSource(original)
  const done = { sessionId: session, turn: 1, eventSeq: 4, sourceIds: [receipt.sourceId], assistant: '', completed: true,
    at: original.at, timezone: original.timezone }
  await owner.completeTurn(done)
  await owner.close()
  owner = openMemoryOwner(options)
  await owner.recover()
  await owner.receiveSource({ ...original, live: false })
  await owner.completeTurn(done)
  await owner.receiveSource({ ...original, messageId: randomUUID(), text: '继续讨论周报。', turn: 2 })
  const call = { id: randomUUID(), session, generation: 0, callId: 'new-turn', turn: 2, step: 1, seq: 7, digest: '5'.repeat(64) }
  assert.equal(await owner.withNativeToolRead({ call, calls: [call], current: () => true }, () => owner.rememberNativeFile(text)), null)
  const current = await owner.receiveSource({ ...original, messageId: randomUUID(), turn: 2 })
  const saved = await owner.withNativeToolRead({ call, calls: [call], current: () => true }, () => owner.rememberNativeFile(text))
  assert.ok(saved)
  assert.deepEqual(owner.runtime.readFile(saved.identity)?.sources.map(source => source.sourceId), [current.sourceId])
})

test('native remember accepts arbitrary current-turn original fragments without a command prefix', async t => {
  const { dir, defer } = scratch(t, 'viva-native-remember-fragments-')
  const owner = openMemoryOwner({ root: dir, compute: () => null, route: () => null, quiesce: async () => {} })
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
    await owner.receiveSource({ sessionId: session, messageId: sourceId, text: example.original, turn: index + 1, step: 1,
      at: Date.now(), timezone: 'UTC', admitted: true, inherited: false })
    const call = { id: randomUUID(), session, generation: 0, callId: `fragment-${index}`, turn: index + 1, step: 1,
      seq: index * 4 + 3, digest: String(index + 6).repeat(64) }
    const saved = await owner.withNativeToolRead({ call, calls: [call], current: () => true }, () => owner.rememberNativeFile(example.text))
    assert.ok(saved)
    assert.ok(owner.runtime.readFile(saved.identity)?.markdown.includes(example.text))
    const proof = owner.dispatch.snapshot(session).files?.find(file => file.id === saved.identity.id)
    const start = example.original.indexOf(example.text)
    assert.deepEqual(proof?.sourceRanges, [{ sourceId, spans: [{ start, end: start + example.text.length }] }])
  }
})

test('native files reuse authenticated user or project scope across topics and keep task answers local', async t => {
  const { dir, defer } = scratch(t, 'viva-native-memory-scope-')
  const owner = openMemoryOwner({ root: dir, hostNamespace: 'viva', dailyNotes: false, compute: () => null, route: () => null, quiesce: async () => {} })
  defer(() => owner.close())
  await owner.recover()
  const project = { kind: 'project' as const, id: 'project-one' }
  const other = { kind: 'project' as const, id: 'project-two' }
  async function original(session: string, text: string, context: import('../src/memory/contracts/memory-contract.ts').MemoryScope,
    boundProject?: typeof project) {
    const sourceId = randomUUID()
    await owner.handleHost('sourceAlias', { operationId: sourceId, sourceId, session, conversation: `topic-${session}`, text, context, project: boundProject })
    await owner.receiveSource({ sessionId: session, messageId: sourceId, text, turn: 1, step: 1, at: Date.now(), timezone: 'UTC', admitted: true, inherited: false })
    return sourceId
  }
  async function remember(session: string, text: string) {
    const call = { id: randomUUID(), session, generation: 0, callId: randomUUID(), turn: 1, step: 1, seq: 3, digest: 'a'.repeat(64) }
    return owner.withNativeToolRead({ call, calls: [call], current: () => true }, () => owner.rememberNativeFile(text))
  }
  const personal = 'I keep personal notes in Spanish.'
  await original('personal', personal, { kind: 'user' })
  const saved = await remember('personal', personal)
  assert.ok(saved)
  await original('personal-next', 'A separate topic.', { kind: 'user' })
  assert.ok(owner.runtime.handle({ op: 'file_read', session: 'personal-next', id: saved.identity.id }, owner.sessionContext('personal-next')).includes(personal))
  assert.ok(owner.runtime.fileProfile().user.some(item => item.text === personal))

  const scoped = 'The release marker is orchid-17.'
  const projectSource = await original('project-first', scoped, project, project)
  const projectFile = await remember('project-first', scoped)
  assert.ok(projectFile)
  await original('project-next', 'Check the current project.', project, project)
  await original('neighbor', 'Check another project.', other, other)
  assert.ok(owner.runtime.handle({ op: 'file_read', session: 'project-next', id: projectFile.identity.id }, owner.sessionContext('project-next')).includes(scoped))
  assert.ok(!owner.runtime.handle({ op: 'file_read', session: 'neighbor', id: projectFile.identity.id }, owner.sessionContext('neighbor')).includes(scoped))
  assert.ok(owner.runtime.fileProfile(project).project?.some(item => item.text === scoped))
  assert.ok(!owner.runtime.fileProfile().user.some(item => item.text === scoped))
  owner.runtime.withdraw({ ids: [projectSource], conversation: 'topic-project-first', onlySources: true })
  assert.equal(owner.runtime.readFile(projectFile.identity), null)
  assert.ok(owner.runtime.readFile(saved.identity), 'withdrawing a project source retains the independent personal file')

  const task = 'task-session', taskContext = { kind: 'task' as const, id: task }
  await original(task, 'Ask for this task language.', taskContext)
  const card = { id: 'language', header: 'Task language', question: 'Which language should this task use?', multiSelect: false, options: [] }
  assert.equal(await owner.handleHost('authorizeGeneralQuestion', { args: [task, 'host-turn', [card], `topic-${task}`, taskContext, undefined, 'show'] }), true)
  const answerId = randomUUID(), answer = 'Use Icelandic for this task.'
  await owner.handleHost('acceptQuestionAnswer', { operationId: answerId, text: answer, session: task, conversation: `topic-${task}`,
    requestId: 'task-question', questionId: card.id, question: card.question, context: taskContext })
  const taskFile = await remember(task, answer)
  assert.ok(taskFile)
  assert.ok(owner.runtime.handle({ op: 'file_read', session: task, id: taskFile.identity.id }, owner.sessionContext(task)).includes(answer))
  assert.ok(!owner.runtime.handle({ op: 'file_read', session: 'personal-next', id: taskFile.identity.id }, owner.sessionContext('personal-next')).includes(answer))
  assert.ok(!owner.runtime.fileProfile().user.some(item => item.text.includes('Icelandic')))
})

test('native remember archives the exact source span for every authenticated PTC ancestor', async t => {
  const { dir, defer } = scratch(t, 'viva-native-remember-family-')
  const owner = openMemoryOwner({ root: dir, dailyNotes: false, compute: () => null, route: () => null, quiesce: async () => {} })
  defer(() => owner.close())
  await owner.recover()
  const session = randomUUID(), sourceId = randomUUID(), text = 'I keep weekly status notes in French.'
  await owner.receiveSource({ sessionId: session, messageId: sourceId, text, turn: 1, step: 1,
    at: Date.now(), timezone: 'UTC', admitted: true, inherited: false })
  const root = { id: randomUUID(), session, generation: 0, callId: 'ptc-root', turn: 1, step: 1, seq: 2, digest: '8'.repeat(64) }
  const leaf = { ...root, id: randomUUID(), callId: 'remember-leaf', seq: 3, digest: '9'.repeat(64),
    ptc: { rootCallId: root.callId, parentCallId: root.callId } }
  const saved = await owner.withNativeToolRead({ call: leaf, calls: [root, leaf], current: () => true }, () => owner.rememberNativeFile(text))
  assert.ok(saved)
  const db = new DatabaseSync(join(dir, 'memory.db'))
  defer(() => db.close())
  const archived = db.prepare('SELECT c.identity,r.evidence FROM owner_native_tool_calls c JOIN owner_native_tool_reads r ON r.call=c.id').all()
    .map(row => ({ call: JSON.parse(String(row.identity)) as { id: string }, evidence: JSON.parse(String(row.evidence)) as {
      sources: string[], fileRanges: Array<{ sourceId: string, spans: Array<{ start: number, end: number }> }>, memoryIds: number[]
    } }))
  assert.deepEqual(new Set(archived.map(item => item.call.id)), new Set([root.id, leaf.id]))
  for (const item of archived) assert.deepEqual(item.evidence, { sources: [], memoryIds: [], fileRanges: [{ sourceId, spans: [{ start: 0, end: text.length }] }] })
})
