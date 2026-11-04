import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { KEEP_ENDED, registerTaskIpc, type TaskService } from '../src/backend/task-ipc.ts'
import type { StoredTask } from '../src/backend/task-store.ts'
import type { IpcRegistry } from '../src/shared/ipc-contract.ts'

/**
 * Background tasks from the window: 后台做 starts a task in a session of its own, its segment hanging off the
 * conversation. What it says is kept there by the backend as the agent says it (task-words.ts), across launches
 * too, until it is closed.
 */

type Message = { role: string, text: string, receipt?: null }
type Started = { ok: boolean, task: { id: string, segmentId: string } }
type Restored = { ok: boolean, task: { id: string, segmentId: string, title: string, words: string, host: { conversationId: string } }, messages: Message[] }
type Call = [string, ...unknown[]]
type Handler = (event: unknown, ...args: unknown[]) => unknown

const user = (text: string): Message => ({ role: 'user', text, receipt: null })
const answer = (text: string): Message => ({ role: 'assistant', text, receipt: null })
const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

/**
 * The IPC over a history db and a task store. relaunch() registers it afresh on the same db and store, as the
 * next launch does: nothing in memory, what was kept on disk. Saves along the way wait in `pending` until run.
 */
function setup({ resumable, stored = [] }: { resumable?: { ok: boolean, reason?: string }, stored?: StoredTask[] } = {}) {
  let n = 0
  const db = openHistoryDb({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-')), 'history.db'), newId: () => `c${++n}` })
  const current = db.save(db.create({ sessionId: 's1', cwd: '/w' }), [user('做周报'), answer('写好了'), user('整理发布说明')])
  let kept = stored
  const store = {
    list: () => kept,
    add: (task: StoredTask) => { kept = [...kept.filter((entry) => entry.id !== task.id), task] },
    remove: (id: string) => { kept = kept.filter((entry) => entry.id !== id) },
  }
  let pending: Array<() => void> = []
  const timers = {
    later: (run: () => void) => { pending = [...pending, run]; return run },
    cancel: (timer: unknown) => { pending = pending.filter((run) => run !== timer) },
  }

  function register() {
    const calls: Call[] = []
    const handlers: Record<string, Handler> = {}
    const ipc = { handle: (channel: string, fn: Handler) => { handlers[channel] = fn } } as unknown as Pick<IpcRegistry, 'handle'>
    const service: TaskService = registerTaskIpc(ipc, {
      db,
      store,
      timers,
      current: () => current,
      agentInfo: () => ({ mode: 'live', model: 'V4' }),
      agent: {
        closeTask: async (taskId: string) => { calls.push(['closeTask', taskId]) },
        cancelTask: async (taskId: string) => { calls.push(['cancelTask', taskId]) },
        steerTask: async (taskId: string, text: string) => { calls.push(['steerTask', taskId, text]); return { ok: true } },
        resumeTask: async (request: { taskId: string }) => { calls.push(['resumeTask', request.taskId]); return resumable ?? { ok: true } },
        promptTask: async (taskId: string, text: string) => { calls.push(['promptTask', taskId, text]) },
        startTask: async (request: unknown) => { calls.push(['startTask', request]); return { ok: true, taskId: 's9' } },
      },
    })
    const call = async <T = unknown>(channel: string, ...args: unknown[]) => await handlers[channel]({}, ...args) as T
    /** The agent says `text` in the task's turn. */
    const says = (taskId: string, text: string) => service.receive({ type: 'task_update', taskId, update: chunk(text) })
    const ends = (taskId: string, stopReason = 'end_turn') => service.receive({ type: 'task_end', taskId, stopReason })
    return { call, calls, service, says, ends }
  }

  const first = register()
  const texts = (segmentId: string) => db.get(segmentId)?.messages.map((m: Message) => m.text)
  const runPending = () => { const runs = pending; pending = []; runs.forEach((run) => run()) }
  return { db, ...first, relaunch: register, current: () => current, kept: () => kept, texts, runPending, pending: () => pending.length }
}

test('what the task says is saved along the way, once however much it says meanwhile, and at once when it ends', async () => {
  const { call, says, ends, texts, runPending, pending, kept } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  says(task.id, '先看提交…')
  says(task.id, '三组改动。')
  assert.equal(pending(), 1, 'one save waiting')
  assert.deepEqual(texts(task.segmentId), ['整理发布说明'], 'not yet saved')
  runPending()
  assert.deepEqual(texts(task.segmentId), ['整理发布说明', '先看提交…三组改动。'])
  assert.equal(kept()[0].endedAt, undefined, 'saved along the way, it is still going')

  says(task.id, '写好了。')
  ends(task.id)
  assert.equal(pending(), 0, 'its end saves at once')
  assert.deepEqual(texts(task.segmentId), ['整理发布说明', '先看提交…三组改动。写好了。'])
  const [done] = kept()
  assert.deepEqual([done.status, Number.isFinite(done.endedAt)], ['done', true], 'ended: kept, to be asked again')
  assert.deepEqual(await call('task:unfinished'), [], 'but not offered as unfinished')
})

test('flushed when Viva quits: what the task said so far is saved, and the task is offered again next launch', async () => {
  const { call, says, service, texts, relaunch } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  says(task.id, '说到一半')
  service.flush()
  assert.deepEqual(texts(task.segmentId), ['整理发布说明', '说到一半'])
  const later = relaunch()
  assert.deepEqual((await later.call<Array<{ id: string }>>('task:unfinished')).map((entry) => entry.id), [task.id])
})

test('words into its turn and answers to its questions are kept with what the task says', async () => {
  const { call, calls, says, ends, service, texts } = setup()
  const { task } = await call<Started>('task:start', { text: '查一下明天的天气' })
  const city = { id: 'city', question: '哪个城市？', options: [{ label: '上海' }, { label: '北京' }] }
  service.receive({ type: 'task_question', taskId: task.id, questionId: 'q1', questions: [city] })
  service.answer('q1', [{ id: 'city', selected: ['上海'] }])
  says(task.id, '上海明天多云。')
  await call('task:steer', task.id, '顺便看看后天')
  assert.deepEqual(calls.at(-1), ['steerTask', task.id, '顺便看看后天'])
  ends(task.id)
  assert.deepEqual(texts(task.segmentId), ['查一下明天的天气', '上海', '上海明天多云。', '顺便看看后天', '本轮没有文字回复。'])
  service.answer('q-unknown', [{ id: 'city', selected: ['北京'] }])
  assert.equal(texts(task.segmentId)?.length, 5, 'an answer to no question of a task held changes nothing')
})

test('a task is kept while it goes on and once it ended, until it is closed; closed, what it said is saved', async () => {
  const ended = setup()
  const { task } = await ended.call<Started>('task:start', { text: '整理发布说明' })
  assert.deepEqual(ended.kept().map((entry) => [entry.id, entry.segmentId, entry.title, entry.keep]), [[task.id, task.segmentId, '整理发布说明', 0]])

  const other = setup()
  const started = await other.call<Started>('task:start', { text: '整理发布说明' })
  other.says(started.task.id, '先看提交…')
  await other.call('task:close', started.task.id)
  assert.deepEqual(other.calls.at(-1), ['closeTask', 's9'])
  assert.deepEqual(other.kept(), [], 'closed: let go')
  assert.deepEqual(other.texts(started.task.segmentId), ['整理发布说明', '先看提交…'], 'what it said up to then is saved')
  assert.equal(other.pending(), 0)
})

test('at the next launch an unfinished task is offered; taken up, it goes on with what it had said', async () => {
  const { call, says, service, relaunch, texts } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  says(task.id, '先看提交…')
  service.flush()
  assert.deepEqual(await call('task:unfinished'), [], 'still going in this launch: nothing to offer')

  const later = relaunch()
  assert.deepEqual((await later.call<Array<{ id: string, title: string }>>('task:unfinished')).map((entry) => [entry.id, entry.title]), [[task.id, '整理发布说明']])
  const taken = await later.call<Restored>('task:resume', task.id)
  assert.equal(taken.ok, true, JSON.stringify(taken))
  assert.deepEqual(taken.task, { id: task.id, segmentId: task.segmentId, title: '整理发布说明', words: '整理发布说明', host: taken.task.host })
  assert.equal(taken.task.host.conversationId, 'c1', 'hung off the conversation it was started from')
  assert.deepEqual(taken.messages.map((m) => m.text), ['整理发布说明', '先看提交…'], 'what it had said, from its own words on')
  assert.deepEqual(later.calls.map(([name, arg]) => [name, arg]), [['resumeTask', task.id], ['promptTask', task.id]])
  later.says(task.id, '写好了')
  later.ends(task.id)
  assert.deepEqual(texts(task.segmentId), ['整理发布说明', '先看提交…', '写好了'], 'going on from what it had said')
  assert.deepEqual(await relaunch().call('task:unfinished'), [], 'taken up and ended: not offered again')
})

test('a task that ended is asked again in its own session; what it says next follows what it said before', async () => {
  const { call, calls, says, ends, kept, texts } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  says(task.id, '写好了')
  ends(task.id)

  const asked = await call('task:ask', task.id, '再加上已知问题')
  assert.deepEqual(asked, { ok: true })
  assert.deepEqual(calls.at(-1), ['promptTask', task.id, '再加上已知问题'], 'its session is still there: asked at once')
  assert.equal(kept()[0].endedAt, undefined, 'going again: a later launch offers to go on with it')
  assert.deepEqual(await call('task:ask', task.id, '还有'), { ok: false, problem: '这件还在做，直接说就会插进去' })
  await assert.rejects(call('task:ask', task.id, ''), /invalid task request/)
  says(task.id, '加好了')
  ends(task.id)
  assert.deepEqual(texts(task.segmentId), ['整理发布说明', '写好了', '再加上已知问题', '加好了'])
})

test('at the next launch tasks that had ended come back with what they said; asked again, their session is taken up first', async () => {
  const { call, says, ends, relaunch, texts } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  says(task.id, '写好了')
  ends(task.id, 'cancelled')

  const later = relaunch()
  const [back] = await later.call<Array<Restored & { status: string }>>('task:finished')
  assert.deepEqual(back.task, { id: task.id, segmentId: task.segmentId, title: '整理发布说明', words: '整理发布说明', host: back.task.host })
  assert.equal(back.task.host.conversationId, 'c1', 'hung off the conversation it was started from')
  assert.equal(back.status, 'stopped')
  assert.deepEqual(back.messages.map((m) => m.text), ['整理发布说明', '写好了'])

  assert.deepEqual(await later.call('task:ask', task.id, '再加上已知问题'), { ok: true })
  assert.deepEqual(later.calls.map(([name, arg]) => [name, arg]), [['resumeTask', task.id], ['promptTask', task.id]])
  later.says(task.id, '加好了')
  later.ends(task.id)
  assert.deepEqual(texts(task.segmentId), ['整理发布说明', '写好了', '再加上已知问题', '加好了'], 'taken up from what was kept, it goes on from there')
  await later.call('task:close', task.id)
  assert.deepEqual(await relaunch().call('task:finished'), [], 'closed: gone for good')
})

test('a task that ended and cannot be taken up says so; only the latest few ended tasks are kept', async () => {
  const old = (i: number): StoredTask => ({ id: `old${i}`, segmentId: 'c1', title: `旧的 ${i}`, words: `旧的 ${i}`, keep: 0, next: 'c1', cwd: '/w', startedAt: i, endedAt: i, status: 'done' })
  const olds = Array.from({ length: KEEP_ENDED }, (_, i) => old(i + 1))
  const { call, ends, relaunch, kept } = setup({ resumable: { ok: false, reason: 'missing' }, stored: olds })
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  ends(task.id)
  assert.deepEqual(kept().map((entry) => entry.id).sort(), [...olds.slice(1).map((entry) => entry.id), task.id].sort(), 'the oldest is let go')

  const refused = await relaunch().call<{ ok: boolean, problem: string }>('task:ask', `old${KEEP_ENDED}`, '再说说')
  assert.equal(refused.ok, false)
  assert.match(refused.problem, /接不上/)
  // One let go while the window still listed it: said the same way, not thrown.
  const letGo = await relaunch().call<{ ok: boolean, problem: string }>('task:ask', 'old1', '再说说')
  assert.deepEqual([letGo.ok, /接不上/.test(letGo.problem)], [false, true])
})

test('a task let go is not offered again; one dsh cannot take up is said so', async () => {
  const { call, relaunch } = setup({ resumable: { ok: false, reason: 'missing' } })
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  const later = relaunch()
  const refused = await later.call<{ ok: boolean, problem: string }>('task:resume', task.id)
  assert.equal(refused.ok, false)
  assert.match(refused.problem, /接不上/)
  await later.call('task:forget', task.id)
  assert.deepEqual(await later.call('task:unfinished'), [])
})

test('后台做: the words start a task of their own, from the conversation so far, kept out of the timeline', async () => {
  const { db, call, calls, current, kept, says, ends, texts } = setup()
  const main = current()

  const started = await call<Started>('task:start', { text: '把这周的提交整理成发布说明' })
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.deepEqual(started.task.id, 's9')
  assert.deepEqual(calls, [['startTask', {}], ['promptTask', 's9', '把这周的提交整理成发布说明']])
  assert.deepEqual(texts(started.task.segmentId), ['把这周的提交整理成发布说明'], 'what it says is kept in its own segment')
  assert.equal(current().id, main.id, 'the conversation on screen stays where it is')
  assert.deepEqual(db.foldsOf(main.id), [], 'no line in the conversation for it: its card is there')
  assert.equal(db.latest()?.conversation.id, main.id, 'and it is not a part of the timeline')
  assert.deepEqual(kept().map((entry) => [entry.id, entry.keep]), [['s9', 0]], 'kept like any task going on')

  says('s9', '写好了')
  ends('s9')
  assert.deepEqual(texts(started.task.segmentId), ['把这周的提交整理成发布说明', '写好了'])
  assert.deepEqual(texts(main.id), ['做周报', '写好了', '整理发布说明'], 'the conversation on screen is left alone')
})

test('后台做 while a turn runs starts from before that turn, named by its words', async () => {
  const { call, calls } = setup()
  await call('task:start', { text: '查一下明天上海的天气', words: '整理发布说明' })
  assert.deepEqual(calls[0], ['startTask', { words: '整理发布说明' }])
  await assert.rejects(call('task:start', { text: '' }), /invalid task request/)
})

test('what an agent says in a task this launch does not hold, or in the conversation on screen, is not kept as a task\'s', () => {
  const { service, texts, current } = setup()
  service.receive({ type: 'task_update', taskId: 'nobody', update: chunk('无主的话') })
  service.receive({ type: 'update', sessionId: 's1', update: chunk('前台的话') })
  service.receive(null)
  service.flush()
  assert.deepEqual(texts(current().id), ['做周报', '写好了', '整理发布说明'])
})
