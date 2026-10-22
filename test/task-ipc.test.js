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
function setup({ busy = true, spun, resumable, stored = [] } = {}) {
  let n = 0
  const db = openHistoryDb({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-')), 'history.db'), newId: () => `c${++n}` })
  let current = db.save(db.create({ sessionId: 's1', cwd: '/w' }), [user('做周报'), answer('写好了'), user('整理发布说明')])
  let active = busy
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
        startTask: async (request) => { calls.push(['startTask', request]); return { ok: true, taskId: 's9' } },
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

test('a task is kept while it goes on and once it ended, until it is closed or undone', async () => {
  const ended = setup()
  const { task } = await ended.call('task:spin-off', { words: '整理发布说明', keep: 2, text: '周会几点' })
  assert.deepEqual(ended.kept().map((entry) => [entry.id, entry.segmentId, entry.title, entry.keep]), [[task.id, task.segmentId, '整理发布说明', 2]])
  await ended.call('task:save', task.id, [user('整理发布说明'), answer('说到一半')])
  assert.equal(ended.kept()[0].endedAt, undefined, 'saved along the way, it is still going')
  await ended.call('task:save', task.id, [user('整理发布说明'), answer('写好了')], { ended: true, status: 'done' })
  const [done] = ended.kept()
  assert.deepEqual([done.id, done.status, Number.isFinite(done.endedAt)], [task.id, 'done', true], 'ended: kept, to be asked again')
  assert.deepEqual(await ended.call('task:unfinished'), [], 'but not offered as unfinished')

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

test('a task that ended is asked again in its own session; it is going again until it ends', async () => {
  const { call, calls, kept } = setup()
  const { task } = await call('task:spin-off', { words: '整理发布说明', keep: 2, text: '周会几点' })
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
  const { task } = await call('task:spin-off', { words: '整理发布说明', keep: 2, text: '周会几点' })
  await call('task:save', task.id, [user('整理发布说明'), answer('写好了')], { ended: true, status: 'stopped' })

  const later = relaunch()
  const [back] = await later.call('task:finished')
  assert.deepEqual(back.task, { id: task.id, segmentId: task.segmentId, title: '整理发布说明', words: '整理发布说明' })
  assert.equal(back.status, 'stopped')
  assert.deepEqual(back.messages.map((m) => m.text), ['整理发布说明', '写好了'])

  assert.deepEqual(await later.call('task:ask', task.id, '再加上已知问题'), { ok: true })
  assert.deepEqual(later.calls.map(([name, arg]) => [name, arg?.taskId ?? arg]), [['resumeTask', task.id], ['promptTask', task.id]])
  await later.call('task:close', task.id)
  assert.deepEqual(await relaunch().call('task:finished'), [], 'closed: gone for good')
})

test('a task that ended and cannot be taken up says so; only the latest few ended tasks are kept', async () => {
  const old = (i) => ({ id: `old${i}`, segmentId: 'c1', title: `旧的 ${i}`, words: `旧的 ${i}`, keep: 0, next: 'c1', cwd: '/w', startedAt: i, endedAt: i, status: 'done' })
  const { call, relaunch, kept } = setup({ resumable: { ok: false, reason: 'missing' }, stored: [1, 2, 3, 4, 5].map(old) })
  const { task } = await call('task:spin-off', { words: '整理发布说明', keep: 2, text: '周会几点' })
  await call('task:save', task.id, [user('整理发布说明'), answer('写好了')], { ended: true, status: 'done' })
  assert.deepEqual(kept().map((entry) => entry.id).sort(), ['old2', 'old3', 'old4', 'old5', task.id].sort(), 'the oldest is let go')

  const refused = await relaunch().call('task:ask', 'old5', '再说说')
  assert.equal(refused.ok, false)
  assert.match(refused.problem, /接不上/)
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

test('后台做: the words start a task of their own, from the conversation so far, kept out of the timeline', async () => {
  const { db, call, calls, current, kept } = setup({ busy: false })
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

test('nothing moves when no turn runs, when the words are not where the window says, or when the agent cannot', async () => {
  assert.deepEqual(await setup({ busy: false }).call('task:spin-off', { words: '整理发布说明', keep: 2, text: 'x' }), { ok: false, reason: 'idle' })
  assert.equal((await setup().call('task:spin-off', { words: '别的', keep: 2, text: 'x' })).ok, false)
  const refused = setup({ spun: { ok: false, reason: 'invalid' } })
  const kept = refused.current()
  assert.equal((await refused.call('task:spin-off', { words: '整理发布说明', keep: 2, text: 'x' })).ok, false)
  assert.equal(refused.current(), kept)
  await assert.rejects(refused.call('task:spin-off', { words: '', keep: 2, text: 'x' }), /invalid task request/)
})
