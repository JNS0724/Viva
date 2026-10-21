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

function setup({ busy = true, spun } = {}) {
  let n = 0
  const db = openHistoryDb({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-')), 'history.db'), newId: () => `c${++n}` })
  let current = db.save(db.create({ sessionId: 's1', cwd: '/w' }), [user('做周报'), answer('写好了'), user('整理发布说明')])
  let active = busy
  const calls = []
  const handlers = {}
  registerTaskIpc({ handle: (channel, fn) => { handlers[channel] = fn } }, {
    db,
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
    },
  })
  const call = (channel, ...args) => handlers[channel]({}, ...args)
  return { db, call, calls, current: () => current, busy: () => active }
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

test('nothing moves when no turn runs, when the words are not where the window says, or when the agent cannot', async () => {
  assert.deepEqual(await setup({ busy: false }).call('task:spin-off', { words: '整理发布说明', keep: 2, text: 'x' }), { ok: false, reason: 'idle' })
  assert.equal((await setup().call('task:spin-off', { words: '别的', keep: 2, text: 'x' })).ok, false)
  const refused = setup({ spun: { ok: false, reason: 'invalid' } })
  const kept = refused.current()
  assert.equal((await refused.call('task:spin-off', { words: '整理发布说明', keep: 2, text: 'x' })).ok, false)
  assert.equal(refused.current(), kept)
  await assert.rejects(refused.call('task:spin-off', { words: '', keep: 2, text: 'x' }), /invalid task request/)
})
