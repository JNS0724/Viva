import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { KEEP_ENDED, registerTaskIpc } from '../src/backend/task-ipc.ts'

/**
 * Background tasks from the window: 后台做 starts a task in a session of its own, its segment hanging off the
 * conversation; what it says is kept there, across launches too, until it is closed.
 */

const user = (text) => ({ role: 'user', text, receipt: null })
const answer = (text) => ({ role: 'assistant', text, receipt: null })

/**
 * The IPC over a history db and a task store. relaunch() registers it afresh on the same db and store, as
 * the next launch does: nothing in memory, what was kept on disk.
 */
function setup({ resumable, stored = [] } = {}) {
  let n = 0
  const db = openHistoryDb({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-')), 'history.db'), newId: () => `c${++n}` })
  let current = db.save(db.create({ sessionId: 's1', cwd: '/w' }), [user('做周报'), answer('写好了'), user('整理发布说明')])
  let kept = stored
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
      agentInfo: () => ({ mode: 'live', model: 'V4' }),
      agent: {
        closeTask: async (taskId) => { calls.push(['closeTask', taskId]) },
        cancelTask: async (taskId) => { calls.push(['cancelTask', taskId]) },
        steerTask: async (taskId, text) => { calls.push(['steerTask', taskId, text]); return { ok: true } },
        resumeTask: async (request) => { calls.push(['resumeTask', request]); return resumable ?? { ok: true } },
        promptTask: async (taskId, text) => { calls.push(['promptTask', taskId, text]) },
        startTask: async (request) => { calls.push(['startTask', request]); return { ok: true, taskId: 's9' } },
      },
    })
    return { call: (channel, ...args) => handlers[channel]({}, ...args), calls }
  }

  const first = register()
  return { db, ...first, relaunch: register, current: () => current, kept: () => kept }
}

test('what the task says is kept in its segment; closing it ends its session', async () => {
  const { db, call, calls } = setup()
  const { task } = await call('task:start', { text: '整理发布说明' })

  await call('task:save', task.id, [user('整理发布说明'), answer('发布说明写好了')])
  assert.deepEqual(db.get(task.segmentId).messages.map((m) => m.text), ['整理发布说明', '发布说明写好了'])

  await call('task:close', task.id)
  assert.deepEqual(calls.at(-1), ['closeTask', 's9'])
  await assert.rejects(call('task:save', task.id, [user('x')]), /no such task/)
})

test('a task is kept while it goes on and once it ended, until it is closed', async () => {
  const ended = setup()
  const { task } = await ended.call('task:start', { text: '整理发布说明' })
  assert.deepEqual(ended.kept().map((entry) => [entry.id, entry.segmentId, entry.title, entry.keep]), [[task.id, task.segmentId, '整理发布说明', 0]])
  await ended.call('task:save', task.id, [user('整理发布说明'), answer('说到一半')])
  assert.equal(ended.kept()[0].endedAt, undefined, 'saved along the way, it is still going')
  await ended.call('task:save', task.id, [user('整理发布说明'), answer('写好了')], { ended: true, status: 'done' })
  const [done] = ended.kept()
  assert.deepEqual([done.id, done.status, Number.isFinite(done.endedAt)], [task.id, 'done', true], 'ended: kept, to be asked again')
  assert.deepEqual(await ended.call('task:unfinished'), [], 'but not offered as unfinished')

  const other = setup()
  const started = await other.call('task:start', { text: '整理发布说明' })
  await other.call('task:close', started.task.id)
  assert.deepEqual(other.kept(), [], 'closed: let go')
})

test('at the next launch an unfinished task is offered; taken up, it goes on with what it had said', async () => {
  const { call, relaunch } = setup()
  const { task } = await call('task:start', { text: '整理发布说明' })
  await call('task:save', task.id, [user('整理发布说明'), answer('先看提交…')])
  assert.deepEqual(await call('task:unfinished'), [], 'still going in this launch: nothing to offer')

  const later = relaunch()
  assert.deepEqual((await later.call('task:unfinished')).map((entry) => [entry.id, entry.title]), [[task.id, '整理发布说明']])
  const taken = await later.call('task:resume', task.id)
  assert.equal(taken.ok, true, JSON.stringify(taken))
  assert.deepEqual(taken.task, { id: task.id, segmentId: task.segmentId, title: '整理发布说明', words: '整理发布说明', host: taken.task.host })
  assert.equal(taken.task.host.conversationId, 'c1', 'hung off the conversation it was started from')
  assert.deepEqual(taken.messages.map((m) => m.text), ['整理发布说明', '先看提交…'], 'what it had said, from its own words on')
  assert.deepEqual(later.calls.map(([name, arg]) => [name, arg?.taskId ?? arg]), [['resumeTask', task.id], ['promptTask', task.id]])
  await later.call('task:save', task.id, [user('整理发布说明'), answer('写好了')], { ended: true })
  assert.deepEqual(await relaunch().call('task:unfinished'), [], 'taken up and ended: not offered again')
})

test('a task that ended is asked again in its own session; it is going again until it ends', async () => {
  const { call, calls, kept } = setup()
  const { task } = await call('task:start', { text: '整理发布说明' })
  await call('task:save', task.id, [user('整理发布说明'), answer('写好了')], { ended: true, status: 'done' })

  const asked = await call('task:ask', task.id, '再加上已知问题')
  assert.deepEqual(asked, { ok: true })
  assert.deepEqual(calls.at(-1), ['promptTask', task.id, '再加上已知问题'], 'its session is still there: asked at once')
  assert.equal(kept()[0].endedAt, undefined, 'going again: a later launch offers to go on with it')
  assert.deepEqual(await call('task:ask', task.id, '还有'), { ok: false, problem: '这件还在做，直接说就会插进去' })
  await assert.rejects(call('task:ask', task.id, ''), /invalid task request/)
})

test('at the next launch tasks that had ended come back with what they said; asked again, their session is taken up first', async () => {
  const { call, relaunch } = setup()
  const { task } = await call('task:start', { text: '整理发布说明' })
  await call('task:save', task.id, [user('整理发布说明'), answer('写好了')], { ended: true, status: 'stopped' })

  const later = relaunch()
  const [back] = await later.call('task:finished')
  assert.deepEqual(back.task, { id: task.id, segmentId: task.segmentId, title: '整理发布说明', words: '整理发布说明', host: back.task.host })
  assert.equal(back.task.host.conversationId, 'c1', 'hung off the conversation it was started from')
  assert.equal(back.status, 'stopped')
  assert.deepEqual(back.messages.map((m) => m.text), ['整理发布说明', '写好了'])

  assert.deepEqual(await later.call('task:ask', task.id, '再加上已知问题'), { ok: true })
  assert.deepEqual(later.calls.map(([name, arg]) => [name, arg?.taskId ?? arg]), [['resumeTask', task.id], ['promptTask', task.id]])
  await later.call('task:close', task.id)
  assert.deepEqual(await relaunch().call('task:finished'), [], 'closed: gone for good')
})

test('a task that ended and cannot be taken up says so; only the latest few ended tasks are kept', async () => {
  const old = (i) => ({ id: `old${i}`, segmentId: 'c1', title: `旧的 ${i}`, words: `旧的 ${i}`, keep: 0, next: 'c1', cwd: '/w', startedAt: i, endedAt: i, status: 'done' })
  const olds = Array.from({ length: KEEP_ENDED }, (_, i) => old(i + 1))
  const { call, relaunch, kept } = setup({ resumable: { ok: false, reason: 'missing' }, stored: olds })
  const { task } = await call('task:start', { text: '整理发布说明' })
  await call('task:save', task.id, [user('整理发布说明'), answer('写好了')], { ended: true, status: 'done' })
  assert.deepEqual(kept().map((entry) => entry.id).sort(), [...olds.slice(1).map((entry) => entry.id), task.id].sort(), 'the oldest is let go')

  const refused = await relaunch().call('task:ask', `old${KEEP_ENDED}`, '再说说')
  assert.equal(refused.ok, false)
  assert.match(refused.problem, /接不上/)
  // One let go while the window still listed it: said the same way, not thrown.
  const letGo = await relaunch().call('task:ask', 'old1', '再说说')
  assert.deepEqual([letGo.ok, /接不上/.test(letGo.problem)], [false, true])
})

test('a task let go is not offered again; one dsh cannot take up is said so', async () => {
  const { call, relaunch } = setup({ resumable: { ok: false, reason: 'missing' } })
  const { task } = await call('task:start', { text: '整理发布说明' })
  const later = relaunch()
  const refused = await later.call('task:resume', task.id)
  assert.equal(refused.ok, false)
  assert.match(refused.problem, /接不上/)
  await later.call('task:forget', task.id)
  assert.deepEqual(await later.call('task:unfinished'), [])
})

test('后台做: the words start a task of their own, from the conversation so far, kept out of the timeline', async () => {
  const { db, call, calls, current, kept } = setup()
  const main = current()

  const started = await call('task:start', { text: '把这周的提交整理成发布说明' })
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.deepEqual(started.task.id, 's9')
  assert.deepEqual(calls, [['startTask', {}], ['promptTask', 's9', '把这周的提交整理成发布说明']])
  assert.deepEqual(db.get(started.task.segmentId).messages.map((m) => m.text), ['把这周的提交整理成发布说明'], 'what it says is kept in its own segment')
  assert.equal(current().id, main.id, 'the conversation on screen stays where it is')
  assert.deepEqual(db.foldsOf(main.id), [], 'no line in the conversation for it: its card is there')
  assert.equal(db.latest().conversation.id, main.id, 'and it is not a part of the timeline')
  assert.deepEqual(kept().map((entry) => [entry.id, entry.keep]), [['s9', 0]], 'kept like any task going on')

  await call('task:save', 's9', [{ role: 'user', text: '把这周的提交整理成发布说明', receipt: null }, answer('写好了')], { ended: true, status: 'done' })
  assert.deepEqual(db.get(started.task.segmentId).messages.map((m) => m.text), ['把这周的提交整理成发布说明', '写好了'])
})

test('后台做 while a turn runs starts from before that turn, named by its words', async () => {
  const { call, calls } = setup()
  await call('task:start', { text: '查一下明天上海的天气', words: '整理发布说明' })
  assert.deepEqual(calls[0], ['startTask', { words: '整理发布说明' }])
  await assert.rejects(call('task:start', { text: '' }), /invalid task request/)
})

