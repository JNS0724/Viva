import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openAppDb, transaction } from '../src/backend/app-db.ts'
import { createEffects } from '../src/backend/effects.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { memoryProjectScope } from '../src/backend/memory-project.ts'
import { createMemoryRuntime } from './fixtures/localized-memory-runtime.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { createMemoryWithdrawal } from '../src/backend/memory-withdrawal.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { memoryOwnerCaller } from './fixtures/memory-owner-caller.ts'
import { runToCrash } from './fixtures/memory-crash-process.ts'
import { extraction, memoryCrashCheckpoints, origin, text } from './fixtures/memory-intake-crash.ts'

const fixture = new URL('./fixtures/memory-intake-crash.ts', import.meta.url)

test('a pending rewind replacement keeps its original project association after Git changes', async t => {
  for (const scoped of [true, false]) await t.test(scoped ? 'Git directory recreated' : 'formerly unscoped directory gains Git', async t => {
    await recoverEditedSource(t, scoped)
  })
})

async function recoverEditedSource(t: import('node:test').TestContext, scoped: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'viva-memory-rewind-project-'))
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const cwd = join(directory, 'work')
  const git = join(cwd, '.git')
  function initGit() {
    mkdirSync(join(git, 'objects'), { recursive: true })
    writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n')
    const project = memoryProjectScope(cwd)
    assert.ok(project)
    return project
  }
  const project = scoped ? initGit() : undefined
  const firstId = randomUUID(), nextId = randomUUID(), oldSource = randomUUID(), newSource = randomUUID()
  const before = '项目构建要求为蓝色版本', revised = '项目构建要求为琥珀色版本'
  async function open(crashBeforeWithdrawal = false) {
    const app = openAppDb({ file: join(directory, 'app.db') })
    const history = openHistoryDb({ db: app.db })
    const effects = createEffects({ db: app.db })
    const owner = openMemoryOwner({ root: join(directory, 'memory'), compute: () => null, route: () => null, quiesce: async () => {} })
    await owner.recover()
    const call = memoryOwnerCaller(owner, method => { if (crashBeforeWithdrawal && method === 'commitSourceChange') throw new Error('stop after history commit') })
    const withdrawal = createMemoryWithdrawal({ history: () => history, effects: () => effects, memory: () => ({ call }),
      apply: (_kind, _data, work) => ({ value: transaction(app.db, work) }), changing: async work => work(),
    })
    return { history, effects, owner, memory: owner.runtime, withdrawal, async close() { await owner.close(); effects.close(); app.close() } }
  }
  const first = await open(true)
  try {
    const saved = first.history.save(first.history.create({ cwd, sessionId: firstId }), [{ role: 'user', text: before, sourceId: oldSource, receipt: null }])
    await first.owner.handleHost('sourceAlias', { operationId: randomUUID(), sourceId: oldSource, session: firstId, conversation: saved.id, text: before, project })
    await first.owner.receiveSource({ sessionId: firstId, messageId: oldSource, text: before, at: Date.now(), timezone: 'Asia/Shanghai', turn: 1, step: 1, admitted: true, inherited: false })
    await assert.rejects(first.withdrawal.commitEdit({ oldSource, newSource, previous: saved,
      next: first.history.create({ cwd, sessionId: nextId, topicId: saved.topicId ?? saved.id }), kept: [], keep: 0, text: revised }), /stop after history commit/u)
    assert.equal(first.memory.sourceCurrent(oldSource), false)
    assert.ok(first.effects.get('memory.withdraw', newSource))
  } finally { await first.close() }

  if (project) renameSync(git, join(cwd, 'previous-git'))
  const replacement = initGit()
  assert.notEqual(replacement.id, project?.id)
  const restarted = await open()
  try {
    await restarted.withdrawal.recover()
    assert.equal(restarted.effects.get('memory.withdraw', newSource), null)
    assert.equal(restarted.memory.sourceCurrent(oldSource), false)
    await restarted.owner.receiveSource({ sessionId: nextId, messageId: newSource, text: revised, at: Date.now(), timezone: 'Asia/Shanghai', turn: 1, step: 1, admitted: true, inherited: false })
    assert.equal(restarted.memory.sessionProject(nextId), project?.id ?? '')
    const source = { dependencies: [], sources: [newSource] }
    if (project) assert.equal(restarted.memory.projectAllows(source, replacement), false)
    assert.equal(restarted.memory.projectAllows(source, project), true)
  } finally { await restarted.close() }
}

test('intake, acknowledgement and extraction recover at their transaction boundaries after process death', { timeout: 60_000 }, async t => {
  for (const checkpoint of memoryCrashCheckpoints) await t.test(checkpoint, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'viva-memory-recovery-'))
    const file = join(directory, 'memory.db')
    t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
    const id = randomUUID()
    const ack = await runToCrash(fixture, checkpoint, file, id)
    const intakeCommitted = checkpoint !== 'before-intake-commit'
    const acknowledged = intakeCommitted && checkpoint !== 'after-intake-commit'
    const resultCommitted = checkpoint === 'after-result-commit'
    assert.deepEqual(ack, acknowledged ? [JSON.stringify({ sourceId: id, outcome: 'pending' })] : [])

    const store = openMemoryStore(file)
    const generations: number[] = []
    const memory = createMemoryRuntime({ store,
      compute: async job => {
        if (job.stage !== 'extract') return '{"refs":[]}'
        assert.equal(job.sourceId, id)
        generations.push(job.generation)
        return extraction
      },
      route: () => ({ provider: 'fixture', model: 'fixture' }), quiesce: async () => {}, changed: () => {},
    })
    try {
      const pending = () => store.db.prepare("SELECT generation FROM effects WHERE kind='memory.extract' AND key=?").get(id)
      const held = pending()?.generation
      assert.equal(Boolean(held), intakeCommitted && !resultCommitted)
      assert.equal(store.readSource(id)?.outcome, resultCommitted ? 'accepted' : intakeCommitted ? 'pending' : undefined)
      assert.equal(memory.listMemories().total, Number(resultCommitted))

      await memory.wake()
      assert.equal(memory.listMemories().total, Number(intakeCommitted))
      assert.deepEqual(generations, held === undefined ? [] : [held])
      if (!intakeCommitted) assert.deepEqual(memory.accept(text, origin, id), { sourceId: id, outcome: 'pending' })
      await memory.wake()
      assert.deepEqual(memory.accept(text, origin, id), { sourceId: id, outcome: 'accepted' })
      await memory.wake()
      assert.equal(generations.length, resultCommitted ? 0 : 1)
      assert.equal(pending(), undefined)
      assert.equal(memory.listMemories().total, 1)
      const [entry] = memory.listMemories().items
      assert.equal(entry.text, text)
      assert.deepEqual(entry.evidence.map(edge => edge.sourceId), [id])
    } finally { memory.close() }
  })
})

test('memory deletion stops use immediately and confirms copy cleanup only after SQLite can checkpoint', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'viva-memory-cleanup-recovery-'))
  const file = join(directory, 'memory.db')
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const removed = '我的常喝饮品是燕麦拿铁'
  const surviving = '我的首选字体是 Inter'
  const words = `${removed} ${surviving}`
  const sourceId = randomUUID()
  const deletionId = randomUUID()
  const hasStoredText = (text: string) => [file, file + '-wal']
    .some(path => existsSync(path) && readFileSync(path).includes(Buffer.from(text)))
  let now = Date.now()
  const open = () => {
    const store = openMemoryStore(file, () => now)
    const memory = createMemoryRuntime({ store, now: () => now,
      route: () => ({ provider: 'fixture', model: 'fixture' }), quiesce: async () => {}, changed: () => {},
      compute: async () => JSON.stringify({ proposals: [removed, surviving].map(text => ({
        spans: [{ start: words.indexOf(text), end: words.indexOf(text) + text.length }],
        kind: 'preference', scope: 'user', modality: 'asserted', attribution: 'self', keywords: [],
      })) }),
    })
    return { store, memory }
  }
  const first = open()
  let deleted: { id: number, revision: number } | undefined
  try {
    first.memory.accept(words, origin, sourceId)
    await first.memory.wake()
    deleted = first.memory.listMemories().items.find(item => item.text === removed)
    assert.ok(deleted)
    assert.deepEqual(first.memory.listMemories().items.map(item => item.text).sort(), [removed, surviving].sort())
    const reader = new DatabaseSync(file, { readOnly: true })
    try {
      reader.exec('BEGIN')
      assert.equal(reader.prepare('SELECT text FROM memory_sources WHERE id=?').get(sourceId)?.text, words)
      assert.deepEqual(await first.memory.deleteMemory(deleted.id, deleted.revision, deletionId), { status: 'stopped' })
      assert.equal(first.memory.cleanupPending(), 1)
      assert.deepEqual(first.memory.listMemories().items.map(item => item.text), [surviving])
      assert.ok(first.store.sourceExcluded(sourceId))
      assert.equal(first.store.readSource(sourceId)?.text?.includes(removed), false)
      assert.equal(reader.prepare('SELECT text FROM memory_sources WHERE id=?').get(sourceId)?.text, words)
      assert.equal(hasStoredText(removed), true)
    } finally { reader.close() }
  } finally { first.memory.close() }

  assert.ok(deleted)
  now += 10 * 60_000
  const second = open()
  try {
    await second.memory.wake()
    assert.equal(second.memory.cleanupPending(), 0)
    assert.deepEqual(await second.memory.deleteMemory(deleted.id, deleted.revision, deletionId), { status: 'cleared' })
    assert.equal(second.store.get(deleted.id), null)
    assert.equal(second.store.readSource(sourceId)?.text?.includes(removed), false)
    assert.deepEqual(second.memory.listMemories().items.map(item => item.text), [surviving])
    assert.equal(second.memory.sourceCurrent(sourceId), false)
    assert.equal(hasStoredText(removed), false)
    assert.equal(hasStoredText(surviving), true)
  } finally { second.memory.close() }
})

test('history withdrawal persists intent before prepare and replays a prepared fence after host transaction failure', async t => {
  for (const point of ['prepare', 'history-commit', 'commit-reply'] as const) await t.test(point, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'viva-host-withdrawal-'))
    t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
    const app = openAppDb({ file: join(directory, 'app.db') })
    const history = openHistoryDb({ db: app.db })
    const effects = createEffects({ db: app.db })
    const owner = openMemoryOwner({ root: join(directory, 'memory'), compute: () => null, route: () => null, quiesce: async () => {} })
    await owner.recover()
    t.after(async () => { await owner.close(); effects.close(); app.close() })
    const source = randomUUID(), session = randomUUID()
    const words = '撤回前的会话来源'
    const conversation = history.save(history.create({ sessionId: session }), [{ role: 'user', text: words, sourceId: source, receipt: null }])
    await owner.handleHost('sourceAlias', { operationId: randomUUID(), sourceId: source, session, conversation: conversation.id, text: words })
    await owner.receiveSource({ sessionId: session, messageId: source, text: words, turn: 1, step: 1, at: Date.now(), timezone: 'Asia/Shanghai', admitted: true, inherited: false })
    let fail = true
    const peer = memoryOwnerCaller(owner)
    const call: import('../src/memory/contracts/host.ts').HostMemoryCaller = async (method, input) => {
      if (fail && point === 'prepare' && method === 'prepareSourceChange') {
        assert.ok(effects.get('memory.withdraw', conversation.id), 'host intent must precede the first remote prepare')
        throw new Error(point)
      }
      const result = await peer(method, input)
      if (fail && point === 'commit-reply' && method === 'commitSourceChange') throw new Error(point)
      return result
    }
    const coordinator = createMemoryWithdrawal({ history: () => history, effects: () => effects, memory: () => ({ call }), changing: async work => work(),
      apply: (kind, _data, work) => {
        if (fail && point === 'history-commit' && kind === 'history.memory.withdrawal') throw new Error(point)
        return { value: transaction(app.db, work) }
      },
    })
    await assert.rejects(coordinator.deleteHistory(conversation.id), new RegExp(point))
    assert.ok(effects.get('memory.withdraw', conversation.id))
    assert.equal(Boolean(history.get(conversation.id)), point !== 'commit-reply', 'history mutates only after successful prepare')
    if (point === 'history-commit') assert.equal(owner.ready(), false, 'the prepared owner keeps all model requests fenced')
    fail = false
    await coordinator.recover()
    await coordinator.recover()
    assert.equal(history.get(conversation.id), null)
    assert.equal(owner.runtime.sourceCurrent(source), false)
    assert.equal(effects.get('memory.withdraw', conversation.id), null)
    assert.equal(owner.ready(), true)
  })
})

test('recovery commits all prepared edits before restoring aliases and isolates a failed item', async t => {
  for (const failFirst of [false, true]) await t.test(failFirst ? 'one commit temporarily fails' : 'two prepared edits after restart', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'viva-multiple-edits-'))
    t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
    async function open() {
      const app = openAppDb({ file: join(directory, 'app.db') })
      const history = openHistoryDb({ db: app.db }), effects = createEffects({ db: app.db })
      const owner = openMemoryOwner({ root: join(directory, 'memory'), compute: () => null, route: () => null, quiesce: async () => {} })
      await owner.recover()
      return { app, history, effects, owner, async close() { await owner.close(); effects.close(); app.close() } }
    }
    const first = await open()
    const intents: Array<{ operationId: string, edit: import('../src/backend/memory-withdrawal.ts').MemoryHistoryEdit }> = []
    try {
      for (let index = 0; index < 2; index++) {
        const oldSource = randomUUID(), newSource = randomUUID(), session = randomUUID(), operationId = randomUUID()
        const text = `原来的项目说明 ${index}`
        const previous = first.history.save(first.history.create({ sessionId: session }), [{ role: 'user', text, sourceId: oldSource, receipt: null }])
        await first.owner.handleHost('sourceAlias', { operationId: oldSource, sourceId: oldSource, session, conversation: previous.id, text })
        await first.owner.receiveSource({ sessionId: session, messageId: oldSource, text, turn: 1, step: 1,
          at: Date.now(), timezone: 'Asia/Shanghai', admitted: true, inherited: false })
        const edit = { oldSource, newSource, previous, next: first.history.create({ sessionId: randomUUID(), topicId: previous.id }),
          kept: [], keep: 0, text: `更正后的项目说明 ${index}` }
        intents.push({ operationId, edit })
      }
      // Both durable host intents precede their remote prepare. Simulate process death before
      // either host transaction or commit RPC completes, leaving both owner barriers prepared.
      for (const { operationId, edit } of intents) {
        const change = { operationId, conversation: edit.previous.id, ids: [edit.oldSource], onlySources: true as const }
        transaction(first.app.db, () => first.effects.queue('memory.withdraw', edit.newSource, { phase: 'intent', change, edit, projectId: null }))
        await first.owner.handleHost('prepareSourceChange', change)
      }
      assert.equal(first.owner.ready(), false)
    } finally { await first.close() }
    const next = await open()
    try {
      let failing = failFirst
      const peer = memoryOwnerCaller(next.owner)
      const call: import('../src/memory/contracts/host.ts').HostMemoryCaller = async (method, input) => {
        if (failing && method === 'commitSourceChange' && 'operationId' in input && input.operationId === intents[0]!.operationId) throw new Error('first commit unavailable')
        return peer(method, input)
      }
      const withdrawal = createMemoryWithdrawal({ history: () => next.history, effects: () => next.effects, memory: () => ({ call }),
        apply: (_kind, _data, work) => ({ value: transaction(next.app.db, work) }), changing: async work => work() })
      if (failFirst) {
        await assert.rejects(withdrawal.recover(), AggregateError)
        assert.equal((await next.owner.handleHost('getOperation', { operationId: intents[1]!.operationId }) as { state: string }).state, 'completed', 'a failed first item must not block the second commit')
        assert.ok(next.effects.get('memory.withdraw', intents[0]!.edit.newSource))
        assert.ok(next.effects.get('memory.withdraw', intents[1]!.edit.newSource), 'alias completion remains retryable while another barrier is prepared')
        failing = false
      }
      await withdrawal.recover()
      await withdrawal.recover()
      assert.equal(next.owner.ready(), true)
      for (const { edit } of intents) {
        assert.equal(next.effects.get('memory.withdraw', edit.newSource), null)
        assert.equal(next.history.get(edit.next.id)?.messages.at(-1)?.text, edit.text)
        assert.equal(next.owner.runtime.sourceCurrent(edit.oldSource), false)
        const received = await next.owner.receiveSource({ sessionId: edit.next.sessionId!, messageId: edit.newSource, text: edit.text,
          turn: 1, step: 1, at: Date.now(), timezone: 'Asia/Shanghai', admitted: true, inherited: false })
        assert.equal(received.sourceId, edit.newSource)
      }
    } finally { await next.close() }
  })
})
