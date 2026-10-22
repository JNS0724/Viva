import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHistoryDb } from '../src/main/history-db.js'
import { registerTaskIpc } from '../src/main/task-ipc.js'

/**
 * Background tasks from the window (phase 3): while a turn runs, words about something else move that turn to
 * the background and the conversation goes on in a new segment; undone, it all goes back as it was.
 */

const user = (text) => ({ role: 'user', text, receipt: null })
const answer = (text) => ({ role: 'assistant', text, receipt: null })

/**
 * The IPC over a history db and a task store. relaunch() registers it afresh on the same db and store, as
 * the next launch does: nothing in memory, what was kept on disk.
 */
function setup({ busy = true, spun, resumable } = {}) {
  let n = 0
  const db = openHistoryDb({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-')), 'history.db'), newId: () => `c${++n}` })
  let current = db.save(db.create({ sessionId: 's1', cwd: '/w' }), [user('做周报'), answer('写好了'), user('整理发布说明')])
  let active = busy
  let kept = []
  const store = {
    list: () => kept,
    add: (task) => { kept = [...kept.filter((entry) => entry.id !== task.id), task] },
    remove: (id) => { kept = kept.filter((entry) => entry.id !== id) },
  }

  function register() {
    const calls = []
    const handlers = {}
    registerTaskIpc({ handle: (channel, fn) => { handlers[channel] = fn } }, {
      db,
      store,
      current: () => current,
      setCurrent: (next) => { current = next },
      isBusy: () => active,
      setBusy: (value) => { active = value },
      agentInfo: () => ({ mode: 'live', model: 'V4' }),
      agent: {
        spinOff: async (request) => { calls.push(['spinOff', request]); return spun ?? { ok: true, taskId: 's1', info: { sessionId: 's2', cwd: '/w' } } },
        mergeBack: async (taskId) => { calls.push(['mergeBack', taskId]); return { ok: true, info: { sessionId: taskId, cwd: '/w' } } },
        closeTask: async (taskId) => { calls.push(['closeTask', taskId]) },
        cancelTask: async (taskId) => { calls.push(['cancelTask', taskId]) },
        steerTask: async (taskId, text) => { calls.push(['steerTask', taskId, text]); return { ok: true } },
        resumeTask: async (request) => { calls.push(['resumeTask', request]); return resumable ?? { ok: true } },
        promptTask: async (taskId, text) => { calls.push(['promptTask', taskId, text]) },
      },
    })
    return { call: (channel, ...args) => handlers[channel]({}, ...args), calls }
  }

  const first = register()
  return { db, ...first, relaunch: register, current: () => current, busy: () => active, kept: () => kept }
}

test('words about something else move the running turn to the background; the conversation goes on without it', async () => {
  const { db, call, calls, current, busy } = setup()
  const before = current()

  const result = await call('task:spin-off', { words: '整理发布说明', keep: 2, text: '周会几点' })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(calls, [['spinOff', { words: '整理发布说明' }]])
  assert.deepEqual(result.task, { id: 's1', segmentId: before.id, title: '整理发布说明', words: '整理发布说明' })
  assert.deepEqual(result.conversation.messages.map((m) => m.text), ['做周报', '写好了'], 'what came before the turn, for the window')
  assert.deepEqual(db.get(current().id).messages.map((m) => m.text), ['做周报', '写好了', '周会几点'])
  assert.deepEqual(result.folds, [{ id: before.id, at: 2, count: 1, kind: 'task' }])
  assert.equal(busy(), false, 'the conversation on screen has no turn running now')
})

test('放到后台 with no new words: the conversation goes on from before the turn, with nothing said yet', async () => {
  const { db, call, current, busy } = setup()
  const result = await call('task:spin-off', { words: '整理发布说明', keep: 2 })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(db.get(current().id).messages.map((m) => m.text), ['做周报', '写好了'])
  assert.equal(busy(), false)
  await assert.rejects(call('task:spin-off', { words: '整理发布说明', keep: 2, text: '' }), /invalid task request/, 'words, when given, are words')
})

test('what the task says is kept in its segment; closing it ends its session', async () => {
  const { db, call, calls } = setup()
  const { task } = await call('task:spin-off', { words: '整理发布说明', keep: 2, text: '周会几点' })

  await call('task:save', task.id, [user('整理发布说明'), answer('发布说明写好了')])
  assert.deepEqual(db.get(task.segmentId).messages.map((m) => m.text), ['做周报', '写好了', '整理发布说明', '发布说明写好了'])

  await call('task:close', task.id)
  assert.deepEqual(calls.at(-1), ['closeTask', 's1'])
  await assert.rejects(call('task:save', task.id, [user('x')]), /no such task/)
})

test('undone, the turn is the conversation on screen again, as if it never left', async () => {
  const { db, call, calls, current, busy } = setup()
  const before = current()
  const spun = await call('task:spin-off', { words: '整理发布说明', keep: 2, text: '周会几点' })
  const after = current()

  const undone = await call('task:undo', spun.task.id)

  assert.equal(undone.ok, true, JSON.stringify(undone))
  assert.deepEqual(calls.at(-1), ['mergeBack', 's1'])
  assert.equal(current().id, before.id)
  assert.deepEqual(undone.conversation.messages.map((m) => m.text), ['做周报', '写好了', '整理发布说明'])
  assert.equal(db.get(after.id), null, 'the segment it went on in is gone')
  assert.deepEqual(db.foldsOf(after.id), [])
  assert.equal(busy(), true, 'its turn is running again')
})

test('a task going on is kept until it ends, is closed or undone, so a later launch can take it up', async () => {
  const ended = setup()
  const { task } = await ended.call('task:spin-off', { words: '整理发布说明', keep: 2, text: '周会几点' })
  assert.deepEqual(ended.kept().map((entry) => [entry.id, entry.segmentId, entry.title, entry.keep]), [[task.id, task.segmentId, '整理发布说明', 2]])
  await ended.call('task:save', task.id, [user('整理发布说明'), answer('说到一半')])
  assert.equal(ended.kept().length, 1, 'saved along the way, it is still going')
  await ended.call('task:save', task.id, [user('整理发布说明'), answer('写好了')], { ended: true })
  assert.deepEqual(ended.kept(), [], 'ended: let go')

  for (const channel of ['task:close', 'task:undo']) {
    const other = setup()
    const spun = await other.call('task:spin-off', { words: '整理发布说明', keep: 2, text: '周会几点' })
    await other.call(channel, spun.task.id)
    assert.deepEqual(other.kept(), [], `${channel}: let go`)
  }
})

test('at the next launch an unfinished task is offered; taken up, it goes on with what it had said', async () => {
  const { call, relaunch } = setup()
  const { task } = await call('task:spin-off', { words: '整理发布说明', keep: 2, text: '周会几点' })
  await call('task:save', task.id, [user('整理发布说明'), answer('先看提交…')])
  assert.deepEqual(await call('task:unfinished'), [], 'still going in this launch: nothing to offer')

  const later = relaunch()
  assert.deepEqual((await later.call('task:unfinished')).map((entry) => [entry.id, entry.title]), [[task.id, '整理发布说明']])
  const taken = await later.call('task:resume', task.id)
  assert.equal(taken.ok, true, JSON.stringify(taken))
  assert.deepEqual(taken.task, { id: task.id, segmentId: task.segmentId, title: '整理发布说明', words: '整理发布说明' })
  assert.deepEqual(taken.messages.map((m) => m.text), ['整理发布说明', '先看提交…'], 'what it had said, from its own words on')
  assert.deepEqual(later.calls.map(([name, arg]) => [name, arg?.taskId ?? arg]), [['resumeTask', task.id], ['promptTask', task.id]])
  await later.call('task:save', task.id, [user('整理发布说明'), answer('写好了')], { ended: true })
  assert.deepEqual(await relaunch().call('task:unfinished'), [], 'taken up and ended: not offered again')
})

test('a task let go is not offered again; one dsh cannot take up is said so', async () => {
  const { call, relaunch } = setup({ resumable: { ok: false, reason: 'missing' } })
  const { task } = await call('task:spin-off', { words: '整理发布说明', keep: 2, text: '周会几点' })
  const later = relaunch()
  const refused = await later.call('task:resume', task.id)
  assert.equal(refused.ok, false)
  assert.match(refused.problem, /接不上/)
  await later.call('task:forget', task.id)
  assert.deepEqual(await later.call('task:unfinished'), [])
})

test('nothing moves when no turn runs, when the words are not where the window says, or when the agent cannot', async () => {
  assert.deepEqual(await setup({ busy: false }).call('task:spin-off', { words: '整理发布说明', keep: 2, text: 'x' }), { ok: false, reason: 'idle' })
  assert.equal((await setup().call('task:spin-off', { words: '别的', keep: 2, text: 'x' })).ok, false)
  const refused = setup({ spun: { ok: false, reason: 'invalid' } })
  const kept = refused.current()
  assert.equal((await refused.call('task:spin-off', { words: '整理发布说明', keep: 2, text: 'x' })).ok, false)
  assert.equal(refused.current(), kept)
  await assert.rejects(refused.call('task:spin-off', { words: '', keep: 2, text: 'x' }), /invalid task request/)
})
