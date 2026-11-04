import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { KEEP_ENDED, MAX_RUNNING, registerTaskIpc, type TaskService } from '../src/backend/task-ipc.ts'
import { createTaskRegistry } from '../src/backend/task-registry.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import { liveTasks } from '../src/renderer/tasks-state.ts'
import type { StoredTask } from '../src/backend/task-store.ts'
import type { IpcRegistry } from '../src/shared/ipc-contract.ts'

/**
 * Background tasks from the window: 后台做 starts a task in a session of its own, its segment hanging off the
 * conversation. What it says is kept there by the backend as the agent says it (task-words.ts), across launches
 * too, until it is closed.
 */

type Message = { role: string, text: string, receipt?: null }
type Started = { ok: boolean, task: { id: string, segmentId: string } }
type Kept = { task: { id: string, segmentId: string, title: string, words: string, host: { conversationId: string } }, status: string, endedAt: number, messages: Message[] }
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
function setup({ resumable, stored = [], steerable = true, waits }: { resumable?: { ok: boolean, reason?: string }, stored?: StoredTask[], steerable?: boolean, waits?: { permissions: readonly unknown[], questions: readonly unknown[] } } = {}) {
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

  const announced: Array<{ type: string, [field: string]: unknown }> = []
  let started = 0

  function register() {
    const calls: Call[] = []
    const registry = createTaskRegistry()
    const handlers: Record<string, Handler> = {}
    const ipc = { handle: (channel: string, fn: Handler) => { handlers[channel] = fn } } as unknown as Pick<IpcRegistry, 'handle'>
    const service: TaskService = registerTaskIpc(ipc, {
      db,
      store,
      timers,
      registry,
      announce: (event) => { announced.push(event) },
      ...(waits ? { waitsOf: () => waits } : {}),
      current: () => current,
      agentInfo: () => ({ mode: 'live', model: 'V4' }),
      agent: {
        closeTask: async (taskId: string) => { calls.push(['closeTask', taskId]) },
        cancelTask: async (taskId: string) => { calls.push(['cancelTask', taskId]) },
        steerTask: async (taskId: string, text: string) => { calls.push(['steerTask', taskId, text]); return { ok: steerable } },
        resumeTask: async (request: { taskId: string }) => { calls.push(['resumeTask', request.taskId]); return resumable ?? { ok: true } },
        promptTask: async (taskId: string, text: string) => { calls.push(['promptTask', taskId, text]) },
        startTask: async (request: unknown) => { calls.push(['startTask', request]); started += 1; return { ok: true, taskId: started === 1 ? 's9' : `s9-${started}` } },
      },
    })
    const call = async <T = unknown>(channel: string, ...args: unknown[]) => await handlers[channel]({}, ...args) as T
    /** The agent says `text` in the task's turn. */
    /** An event from the agent, as compose.ts passes it on: to the registry and to the task service. */
    const emit = (event: object) => { registry.receive(event); service.receive(event) }
    const says = (taskId: string, text: string) => emit({ type: 'task_update', taskId, update: chunk(text) })
    const ends = (taskId: string, stopReason = 'end_turn') => emit({ type: 'task_end', taskId, stopReason })
    return { call, calls, service, says, ends }
  }

  const first = register()
  const texts = (segmentId: string) => db.get(segmentId)?.messages.map((m: Message) => m.text)
  const runPending = () => { const runs = pending; pending = []; runs.forEach((run) => run()) }
  return { db, ...first, relaunch: register, current: () => current, kept: () => kept, texts, runPending, pending: () => pending.length, announced }
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
  assert.deepEqual((await setupKept(call)).map((entry) => entry.status), ['done'], 'listed for a window that opens, as it ended')
})

test('flushed when Viva quits: what the task said so far is saved, and the next launch lists it as interrupted', async () => {
  const { call, says, service, texts, relaunch } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  says(task.id, '说到一半')
  service.flush()
  assert.deepEqual(texts(task.segmentId), ['整理发布说明', '说到一半'])
  const [kept] = await relaunch().call<Kept[]>('task:finished')
  assert.deepEqual([kept.task.id, kept.status, kept.messages.map((m) => m.text)], [task.id, 'interrupted', ['整理发布说明', '说到一半']])
})

test('words into its turn and answers to its questions are kept with what the task says', async () => {
  const { call, calls, says, ends, service, texts } = setup()
  const { task } = await call<Started>('task:start', { text: '查一下明天的天气' })
  const city = { id: 'city', question: '哪个城市？', options: [{ label: '上海' }, { label: '北京' }] }
  service.receive({ type: 'task_question', taskId: task.id, questionId: 'q1', questions: [city] })
  service.answer('q1', [{ id: 'city', selected: ['上海'] }])
  says(task.id, '上海明天多云。')
  await service.agentMessage(task.id, '顺便看看后天')
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

test('at the next launch an unfinished task is listed as interrupted; messaged, it is taken up and goes on from what it had said', async () => {
  const { call, says, service, relaunch, texts, announced } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  says(task.id, '先看提交…')
  service.flush()

  const later = relaunch()
  const [kept] = await later.call<Kept[]>('task:finished')
  assert.deepEqual(kept.task, { id: task.id, segmentId: task.segmentId, title: '整理发布说明', words: '整理发布说明', host: kept.task.host })
  assert.equal(kept.task.host.conversationId, 'c1', 'hung off the conversation it was started from')
  assert.deepEqual([kept.status, kept.messages.map((m) => m.text)], ['interrupted', ['整理发布说明', '先看提交…']])
  assert.deepEqual(await later.service.agentMessage(task.id, '接着做'), { taskId: task.id, delivered: 'taken up again' })
  assert.deepEqual(later.calls, [['resumeTask', task.id], ['promptTask', task.id, '接着做']])
  assert.equal((announced.at(-1)?.messages as Message[]).at(-1)?.text, '接着做', 'the window gets what it said, with the new words')
  later.says(task.id, '写好了')
  later.ends(task.id)
  assert.deepEqual(texts(task.segmentId), ['整理发布说明', '先看提交…', '接着做', '写好了'], 'going on from what it had said')
  assert.deepEqual((await relaunch().call<Kept[]>('task:finished')).map((entry) => entry.status), ['done'], 'taken up and ended: kept as done')
})

test('a task that ended is asked again in its own session; what it says next follows what it said before', async () => {
  const { call, calls, says, ends, kept, texts, service } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  says(task.id, '写好了')
  ends(task.id)

  assert.deepEqual(await service.agentMessage(task.id, '再加上已知问题'), { taskId: task.id, delivered: 'next question' })
  assert.deepEqual(calls.at(-1), ['promptTask', task.id, '再加上已知问题'], 'its session is still there: asked at once')
  assert.equal(kept()[0].endedAt, undefined, 'going again: a later launch lists it as interrupted')
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
  const [back] = await later.call<Kept[]>('task:finished')
  assert.deepEqual(back.task, { id: task.id, segmentId: task.segmentId, title: '整理发布说明', words: '整理发布说明', host: back.task.host })
  assert.equal(back.status, 'stopped')
  assert.deepEqual(back.messages.map((m) => m.text), ['整理发布说明', '写好了'])

  assert.deepEqual(await later.service.agentMessage(task.id, '再加上已知问题'), { taskId: task.id, delivered: 'next question' })
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

  await assert.rejects(relaunch().service.agentMessage(`old${KEEP_ENDED}`, '再说说'), /接不上/)
  await assert.rejects(relaunch().service.agentMessage('old1', '再说说'), /接不上/, 'one let go meanwhile: said the same way')
})

test('an interrupted task dsh cannot take up says so; closed, it is not listed again', async () => {
  const { call, relaunch } = setup({ resumable: { ok: false, reason: 'missing' } })
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  const later = relaunch()
  assert.deepEqual((await later.call<Kept[]>('task:finished')).map((entry) => entry.status), ['interrupted'])
  await assert.rejects(later.service.agentMessage(task.id, '接着做'), /接不上/)
  await later.call('task:close', task.id)
  assert.deepEqual(await relaunch().call('task:finished'), [])
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

test('the agent starts a task afresh from its brief; the window is told, and the card says the brief', async () => {
  const { service, calls, announced, texts, kept } = setup()
  const result = await service.agentStart('把 docs 里的发布说明按版本整理好，输出中文')
  assert.deepEqual(result, { taskId: 's9', title: '把 docs 里的发布说明按版本整理好，输出中文', status: 'running' })
  assert.deepEqual(calls.slice(0, 2), [['startTask', { afresh: true }], ['promptTask', 's9', '把 docs 里的发布说明按版本整理好，输出中文']])
  assert.deepEqual(announced.map((event) => [event.type, (event.task as { id: string }).id, event.text]), [['task_created', 's9', '把 docs 里的发布说明按版本整理好，输出中文']])
  assert.deepEqual(texts(kept()[0].segmentId), ['把 docs 里的发布说明按版本整理好，输出中文'])
})

test(`at most ${MAX_RUNNING} tasks work at once: one more is refused, not queued, by the agent and by 后台做 alike`, async () => {
  const { service, call, ends } = setup()
  const ids = []
  for (let i = 0; i < MAX_RUNNING; i++) ids.push((await service.agentStart(`任务 ${i}`)).taskId)
  await assert.rejects(service.agentStart('再来一个'), /最多 5 个/)
  assert.match((await call<{ ok: boolean, problem: string }>('task:start', { text: '后台做一个' })).problem, /最多 5 个/)
  ends(ids[0])
  assert.equal((await service.agentStart('现在可以了')).status, 'running', 'one ended: room for another')
})

test('the agent messages a task: into its turn while it works, its next question once it ended', async () => {
  const { service, calls, announced, says, ends, texts, kept } = setup()
  const { taskId } = await service.agentStart('整理发布说明')
  assert.deepEqual(await service.agentMessage(taskId, '加上版本号'), { taskId, delivered: 'into its turn' })
  assert.deepEqual(calls.at(-1), ['steerTask', taskId, '加上版本号'])
  says(taskId, '写好了')
  ends(taskId)
  assert.deepEqual(await service.agentMessage(taskId, '再加上已知问题'), { taskId, delivered: 'next question' })
  assert.deepEqual(calls.at(-1), ['promptTask', taskId, '再加上已知问题'])
  assert.deepEqual(announced.map((event) => event.type), ['task_created', 'task_steered', 'task_asked'])
  ends(taskId)
  assert.deepEqual(texts(kept()[0].segmentId), ['整理发布说明', '加上版本号', '写好了', '再加上已知问题', '本轮没有文字回复。'])
})

test('a message to a task an earlier launch left unfinished takes it up again with those words', async () => {
  const { service, says, relaunch } = setup()
  const { taskId } = await service.agentStart('整理发布说明')
  says(taskId, '先看提交…')
  service.flush()
  const later = relaunch()
  assert.deepEqual(await later.service.agentMessage(taskId, '接着做，写完为止'), { taskId, delivered: 'taken up again' })
  assert.deepEqual(later.calls, [['resumeTask', taskId], ['promptTask', taskId, '接着做，写完为止']])
})

test('the agent stops a task at work; one that ended or is not held says so; one unknown is refused', async () => {
  const { service, calls, ends } = setup()
  const { taskId } = await service.agentStart('整理发布说明')
  assert.deepEqual(await service.agentStop(taskId), { taskId, stopped: true })
  assert.deepEqual(calls.at(-1), ['cancelTask', taskId])
  ends(taskId, 'cancelled')
  assert.deepEqual(await service.agentStop(taskId), { taskId, stopped: false, status: 'stopped' })
  await assert.rejects(service.agentStop('nobody'), /接不上/)
  await assert.rejects(service.agentMessage('nobody', '在吗'), /接不上/)
})

test('words that do not reach a task at work are said so, not taken for delivered', async () => {
  const { service } = setup({ steerable: false })
  const { taskId } = await service.agentStart('整理发布说明')
  await assert.rejects(service.agentMessage(taskId, '加上版本号'), /话没有送到/)
})

/** What `task:finished` lists of the tasks kept, for a window that opens. */
const setupKept = (call: <T>(channel: string, ...args: unknown[]) => Promise<T>) => call<Kept[]>('task:finished')

test('a window reloaded while a task works gets it back at work, with what it said so far, saved or not', async () => {
  const { call, says } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  says(task.id, '先看提交…')
  const [listed] = await call<Array<Kept & { startedAt: number | null }>>('task:finished')
  assert.deepEqual([listed.task.id, listed.status, listed.endedAt, typeof listed.startedAt], [task.id, 'running', null, 'number'])
  assert.deepEqual(listed.messages.map((m) => m.text), ['整理发布说明', '先看提交…'], 'what it said, before the save along the way')
  const state = reduce(initialState, { type: 'tasks_restored', list: [listed] })
  assert.deepEqual([state.tasks.list[0].status, liveTasks(state).length], ['running', 1], 'at work in the window again')
  const said = reduce(state, { type: 'task_update', taskId: task.id, update: chunk('三组改动。'), at: 5 })
  assert.equal(said.tasks.list[0].view.messages.at(-1)?.text, '先看提交…三组改动。', 'what it says next follows on')
})

test('after dsh went, a message to a task takes its session up again first, rather than prompting one dsh forgot', async () => {
  const { service, calls, ends } = setup()
  const { taskId } = await service.agentStart('整理发布说明')
  ends(taskId, 'error')
  service.detachAll()
  assert.deepEqual(await service.agentMessage(taskId, '接着做'), { taskId, delivered: 'next question' })
  assert.deepEqual(calls.slice(-2), [['resumeTask', taskId], ['promptTask', taskId, '接着做']])
})

test('an answer is kept even though dsh closes the question as it takes the answer', async () => {
  const { call, service, ends, texts } = setup()
  const { task } = await call<Started>('task:start', { text: '查一下明天的天气' })
  const city = { id: 'city', question: '哪个城市？', options: [{ label: '上海' }, { label: '北京' }] }
  service.receive({ type: 'task_question', taskId: task.id, questionId: 'q1', questions: [city] })
  // As compose.ts does: held, then dsh takes the answer (and says the question closed), then kept.
  const keep = service.holdQuestion('q1')
  service.receive({ type: 'task_question_closed', taskId: task.id, questionId: 'q1' })
  keep?.([{ id: 'city', selected: ['北京'] }])
  ends(task.id)
  assert.deepEqual(texts(task.segmentId), ['查一下明天的天气', '北京', '本轮没有文字回复。'])
  assert.equal(service.holdQuestion('q-unknown'), null)
})

test('a window reloaded while a task waits on the user shows what it waits for, to answer it there', async () => {
  const permission = { requestId: 'p1', toolCall: { toolCallId: 't1', title: '写入 docs/release.md' }, options: [{ optionId: 'ok', name: '允许', kind: 'allow_once' }] }
  const question = { questionId: 'q1', questions: [{ id: 'city', question: '哪个城市？', options: [{ label: '上海' }] }] }
  for (const [name, waits] of [['permission', { permissions: [permission], questions: [] }], ['question', { permissions: [], questions: [question] }]] as const) {
    const { call } = setup({ waits })
    const { task } = await call<Started>('task:start', { text: '整理发布说明' })
    const listed = await call<Kept[]>('task:finished')
    const state = reduce(initialState, { type: 'tasks_restored', list: listed })
    const [restored] = state.tasks.list
    assert.equal(restored.status, 'waiting', name)
    if (name === 'permission') assert.equal(restored.view.permission?.requestId, 'p1')
    else assert.equal(restored.view.question?.questionId, 'q1')
    assert.equal(restored.id, task.id)
  }
})

test('a window reloaded while a task streams its answer carries the same message on, not a second one', async () => {
  const { call, service } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  const stream = (kind: string, extra: object) => service.receive({ type: 'task_update', taskId: task.id, update: { sessionUpdate: 'viva_stream', key: 'k1', kind, ...extra } })
  stream('delta', { index: 0, blockType: 'text', text: '前半段' })
  const state = reduce(initialState, { type: 'tasks_restored', list: await call<Kept[]>('task:finished') })
  const next = reduce(state, { type: 'task_update', taskId: task.id, at: 9, update: { sessionUpdate: 'viva_stream', key: 'k1', kind: 'delta', index: 0, blockType: 'text', text: '后半段' } })
  const settled = reduce(next, { type: 'task_update', taskId: task.id, at: 10, update: { sessionUpdate: 'viva_stream', key: 'k1', kind: 'settle', blocks: [{ type: 'text', text: '前半段后半段' }] } })
  assert.deepEqual(settled.tasks.list[0].view.messages.map((m: { text: string }) => m.text), ['整理发布说明', '前半段后半段'])
})

test('a stream with words said into it, then a reload, still settles into one message', async () => {
  const { call, service } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  const update = (kind: string, extra: object) => ({ sessionUpdate: 'viva_stream', key: 'k1', kind, ...extra })
  service.receive({ type: 'task_update', taskId: task.id, update: update('delta', { index: 0, blockType: 'text', text: '前半段' }) })
  await service.agentMessage(task.id, '用户补充')
  const state = reduce(initialState, { type: 'tasks_restored', list: await call<Kept[]>('task:finished') })
  const more = reduce(state, { type: 'task_update', taskId: task.id, at: 9, update: update('delta', { index: 0, blockType: 'text', text: '后半段' }) })
  const settled = reduce(more, { type: 'task_update', taskId: task.id, at: 10, update: update('settle', { blocks: [{ type: 'text', text: '前半段后半段' }] }) })
  assert.deepEqual(settled.tasks.list[0].view.messages.map((m: { text: string }) => m.text), ['整理发布说明', '前半段后半段', '用户补充'])
})
