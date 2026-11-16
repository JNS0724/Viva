import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openAppDb, transaction } from '../src/backend/app-db.ts'
import { createEffects } from '../src/backend/effects.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { memoryProjectScope } from '../src/backend/memory-project.ts'
import { createMemoryWithdrawal } from '../src/backend/memory-withdrawal.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { memoryOwnerCaller } from './fixtures/memory-owner-caller.ts'


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
