import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { registerTaskIpc } from '../src/backend/task-ipc.ts'
import { KEEP_ENDED, MAX_RUNNING, createTaskRuntime, type TaskPiece, type TaskPush, type TaskRuntime, type WindowSnapshot } from '../src/backend/task-runtime.ts'
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
function setup({ resumable, stored = [], steerable = true, waits, startable = () => true, gate = async () => {}, onPrompt = () => {} }: {
  resumable?: { ok: boolean, reason?: string }, stored?: StoredTask[], steerable?: boolean, waits?: { permissions: readonly unknown[], questions: readonly unknown[] },
  startable?: () => boolean,
  /** Waited on before dsh answers a task's start: the test lets each through when it likes. */
  gate?: () => Promise<void>,
  /** As a task's turn is asked (just after its start is kept). */
  onPrompt?: (taskId: string) => void,
} = {}) {
  let n = 0
  const db = openHistoryDb({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-')), 'history.db'), newId: () => `c${++n}` })
  const current = db.save(db.create({ sessionId: 's1', cwd: '/w' }), [user('做周报'), answer('写好了'), user('整理发布说明')])
  let kept = stored
  /** The tasks' events (the runtime's apply), and how many snapshots went out while one was still being written. */
  const events: Array<{ kind: string, data: Record<string, unknown> }> = []
  let depth = 0
  /** The change being written, and which change each write of the store was part of ('' for none). */
  let writing = ''
  const writtenIn: string[] = []
  let pushedInside = 0
  /** Every write of the store, in order: what each kept. */
  const writes: StoredTask[] = []
  const store = {
    list: () => kept,
    add: (task: StoredTask) => { writes.push(task); writtenIn.push(writing); kept = [...kept.filter((entry) => entry.id !== task.id), task] },
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
    const snapshots: WindowSnapshot[] = []
    /** Everything that went to the window, in order: snapshots and the pieces of tasks' streams. */
    const pushes: TaskPush[] = []
    let runs = 0
    const handlers: Record<string, Handler> = {}
    const ipc = { handle: (channel: string, fn: Handler) => { handlers[channel] = fn } } as unknown as Pick<IpcRegistry, 'handle'>
    const tasks: TaskRuntime = createTaskRuntime({
      db,
      store,
      timers,
      apply: (kind, data, write) => {
        depth += 1
        const outer = writing
        writing = kind
        try {
          const value = write()
          events.push({ kind, data })
          return { value }
        } finally {
          depth -= 1
          writing = outer
        }
      },
      publish: (push) => {
        pushes.push(push)
        if (push.type === 'task_snapshot') snapshots.push((push as { snapshot: WindowSnapshot }).snapshot)
        if (depth > 0) pushedInside += 1
      },
      newRunId: () => `run-${++runs}`,
      announce: (event) => { announced.push(event) },
      ...(waits ? { waitsOf: () => waits } : {}),
      current: () => current,
      agentInfo: () => ({ mode: 'live', model: 'V4' }),
      agent: {
        closeTask: async (taskId: string) => { calls.push(['closeTask', taskId]) },
        cancelTask: async (taskId: string) => { calls.push(['cancelTask', taskId]) },
        steerTask: async (taskId: string, text: string) => { calls.push(['steerTask', taskId, text]); return { ok: steerable } },
        resumeTask: async (request: { taskId: string }) => { calls.push(['resumeTask', request.taskId]); return resumable ?? { ok: true } },
        promptTask: async (taskId: string, text: string) => { calls.push(['promptTask', taskId, text]); onPrompt(taskId) },
        startTask: async (request: unknown) => {
          calls.push(['startTask', request])
          await gate()
          if (!startable()) return { ok: false, reason: 'missing' }
          started += 1
          return { ok: true, taskId: started === 1 ? 's9' : `s9-${started}` }
        },
      },
    })
    registerTaskIpc(ipc, tasks.window)
    const call = async <T = unknown>(channel: string, ...args: unknown[]) => await handlers[channel]({}, ...args) as T
    /** The agent says `text` in the task's turn. */
    /** An event from the agent, as compose.ts passes it on (its end and waits by way of their signals). */
    const emit = (event: object) => tasks.dsh.receive(event)
    const says = (taskId: string, text: string) => emit({ type: 'task_update', taskId, update: chunk(text) })
    const ends = (taskId: string, stopReason = 'end_turn') => emit({ type: 'task_end', taskId, stopReason })
    return { call, calls, tasks, says, ends, snapshots, pushes, emit }
  }

  const first = register()
  const texts = (segmentId: string) => db.get(segmentId)?.messages.map((m: Message) => m.text)
  const runPending = () => { const runs = pending; pending = []; runs.forEach((run) => run()) }
  return { db, ...first, relaunch: register, current: () => current, kept: () => kept, writes, events, writtenIn, pushedInside: () => pushedInside, texts, runPending, pending: () => pending.length, announced }
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

test('each change of a task is one event with its task and run; a run is a turn, from its start or the next question', async () => {
  const { call, says, ends, events, snapshots } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  says(task.id, '写好了。')
  ends(task.id)
  const kinds = events.map(({ kind, data }) => [kind, data.taskId, data.runId ?? null, data.status ?? null])
  assert.deepEqual(kinds, [['task.started', task.id, 'run-1', null], ['task.ended', task.id, 'run-1', 'done']])
  assert.ok(snapshots.filter((snapshot) => snapshot.taskId === task.id).every((snapshot) => snapshot.runId === 'run-1'), 'its snapshots carry the run')
})

test('asked again, a task starts a new run; closed, it is one event more', async () => {
  const { call, ends, events, tasks, snapshots } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  ends(task.id)
  await tasks.agent.message(task.id, '再加上已知问题')
  ends(task.id, 'cancelled')
  await call('task:close', task.id)
  assert.deepEqual(events.map(({ kind, data }) => [kind, data.runId ?? null, data.status ?? null]), [
    ['task.started', 'run-1', null], ['task.ended', 'run-1', 'done'],
    ['task.restarted', 'run-2', null], ['task.ended', 'run-2', 'stopped'],
    ['task.closed', null, null],
  ])
  assert.equal(snapshots.findLast((snapshot) => snapshot.taskId === task.id)?.runId, 'run-2')
})

test('a task\'s end is written inside its event\'s transaction, and the window hears of it only once that commits', async () => {
  const { call, says, ends, writtenIn, pushedInside, snapshots } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  says(task.id, '写好了。')
  const before = writtenIn.length
  ends(task.id)
  assert.deepEqual(writtenIn.slice(before), ['task.ended'], 'its ending kept as part of the change')
  assert.equal(writtenIn.filter((kind) => kind === '').length, 0, 'the store is never written outside a change')
  assert.equal(pushedInside(), 0, 'no snapshot goes out while its change is being written')
  assert.equal(snapshots.findLast((snapshot) => snapshot.taskId === task.id)?.status, 'done', 'it goes out after')
})

test('an end for a task not at work is no change: closed meanwhile, or ended already', async () => {
  const { call, ends, events } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  ends(task.id)
  ends(task.id)
  await call('task:close', task.id)
  ends(task.id)
  ends('nobody')
  assert.deepEqual(events.map(({ kind }) => kind), ['task.started', 'task.ended', 'task.closed'])
})

test('a task\'s ending is kept once, as the registry decided it: the store and the window say the same', async () => {
  const { call, says, ends, kept, writes, snapshots } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  says(task.id, '写好了。')
  const before = writes.length
  ends(task.id, 'cancelled')
  const ending = snapshots.findLast((snapshot) => snapshot.taskId === task.id)
  const endings = writes.slice(before).filter((entry) => entry.id === task.id && Number.isFinite(entry.endedAt))
  assert.equal(endings.length, 1, 'one write for one ending')
  const [stored] = kept()
  assert.deepEqual([stored.status, stored.endedAt, stored.resultPreview], [ending?.status, ending?.endedAt, ending?.resultPreview],
    'kept with the registry\'s status, time and last words')
  assert.equal(stored.status, 'stopped', 'stopped by the user')
})

test('flushed when Viva quits: what the task said so far is saved, and the next launch lists it as interrupted', async () => {
  const { call, says, tasks, texts, relaunch } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  says(task.id, '说到一半')
  tasks.dsh.flush()
  assert.deepEqual(texts(task.segmentId), ['整理发布说明', '说到一半'])
  const [kept] = await relaunch().call<Kept[]>('task:finished')
  assert.deepEqual([kept.task.id, kept.status, kept.messages.map((m) => m.text)], [task.id, 'interrupted', ['整理发布说明', '说到一半']])
})

test('words into its turn and answers to its questions are kept with what the task says', async () => {
  const { call, calls, says, ends, tasks, texts } = setup()
  const { task } = await call<Started>('task:start', { text: '查一下明天的天气' })
  const city = { id: 'city', question: '哪个城市？', options: [{ label: '上海' }, { label: '北京' }] }
  tasks.dsh.receive({ type: 'task_question', taskId: task.id, questionId: 'q1', questions: [city] })
  tasks.dsh.answer('q1', [{ id: 'city', selected: ['上海'] }])
  says(task.id, '上海明天多云。')
  await tasks.agent.message(task.id, '顺便看看后天')
  assert.deepEqual(calls.at(-1), ['steerTask', task.id, '顺便看看后天'])
  ends(task.id)
  assert.deepEqual(texts(task.segmentId), ['查一下明天的天气', '上海', '上海明天多云。', '顺便看看后天', '本轮没有文字回复。'])
  tasks.dsh.answer('q-unknown', [{ id: 'city', selected: ['北京'] }])
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
  const { call, says, tasks, relaunch, texts } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  says(task.id, '先看提交…')
  tasks.dsh.flush()

  const later = relaunch()
  const [kept] = await later.call<Kept[]>('task:finished')
  assert.deepEqual(kept.task, { id: task.id, segmentId: task.segmentId, title: '整理发布说明', words: '整理发布说明', host: kept.task.host })
  assert.equal(kept.task.host.conversationId, 'c1', 'hung off the conversation it was started from')
  assert.deepEqual([kept.status, kept.messages.map((m) => m.text)], ['interrupted', ['整理发布说明', '先看提交…']])
  assert.deepEqual(await later.tasks.agent.message(task.id, '接着做'), { taskId: task.id, delivered: 'taken up again' })
  assert.deepEqual(later.calls, [['resumeTask', task.id], ['promptTask', task.id, '接着做']])
  const begun = later.snapshots.findLast((snapshot) => snapshot.taskId === task.id)
  assert.deepEqual([begun?.runId, begun?.opening?.words], ['run-1', '接着做'], 'the window gets the new run by its snapshot, with the words it goes on from')
  later.says(task.id, '写好了')
  later.ends(task.id)
  assert.deepEqual(texts(task.segmentId), ['整理发布说明', '先看提交…', '接着做', '写好了'], 'going on from what it had said')
  assert.deepEqual((await relaunch().call<Kept[]>('task:finished')).map((entry) => entry.status), ['done'], 'taken up and ended: kept as done')
})

test('a task that ended is asked again in its own session; what it says next follows what it said before', async () => {
  const { call, calls, says, ends, kept, texts, tasks } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  says(task.id, '写好了')
  ends(task.id)

  assert.deepEqual(await tasks.agent.message(task.id, '再加上已知问题'), { taskId: task.id, delivered: 'next question' })
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

  assert.deepEqual(await later.tasks.agent.message(task.id, '再加上已知问题'), { taskId: task.id, delivered: 'next question' })
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

  await assert.rejects(relaunch().tasks.agent.message(`old${KEEP_ENDED}`, '再说说'), /接不上/)
  await assert.rejects(relaunch().tasks.agent.message('old1', '再说说'), /接不上/, 'one let go meanwhile: said the same way')
})

test('an interrupted task dsh cannot take up says so; closed, it is not listed again', async () => {
  const { call, relaunch } = setup({ resumable: { ok: false, reason: 'missing' } })
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  const later = relaunch()
  assert.deepEqual((await later.call<Kept[]>('task:finished')).map((entry) => entry.status), ['interrupted'])
  await assert.rejects(later.tasks.agent.message(task.id, '接着做'), /接不上/)
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
  const { tasks, texts, current } = setup()
  tasks.dsh.receive({ type: 'task_update', taskId: 'nobody', update: chunk('无主的话') })
  tasks.dsh.receive({ type: 'update', sessionId: 's1', update: chunk('前台的话') })
  tasks.dsh.receive(null)
  tasks.dsh.flush()
  assert.deepEqual(texts(current().id), ['做周报', '写好了', '整理发布说明'])
})

test('the agent starts a task afresh from its brief; the window is told, and the card says the brief', async () => {
  const { tasks, calls, announced, texts, kept, snapshots } = setup()
  const result = await tasks.agent.start('把 docs 里的发布说明按版本整理好，输出中文')
  assert.deepEqual(result, { taskId: 's9', title: '把 docs 里的发布说明按版本整理好，输出中文', status: 'running' })
  assert.deepEqual(calls.slice(0, 2), [['startTask', { afresh: true }], ['promptTask', 's9', '把 docs 里的发布说明按版本整理好，输出中文']])
  const [made] = snapshots
  assert.deepEqual([made.taskId, made.opening?.words, made.opening?.task?.id, made.opening?.hostSession], ['s9', '把 docs 里的发布说明按版本整理好，输出中文', 's9', 's1'],
    'the window is told by the snapshot that makes it: the brief, and the conversation its card goes in')
  assert.deepEqual(announced, [], 'nothing else to tell')
  assert.deepEqual(texts(kept()[0].segmentId), ['把 docs 里的发布说明按版本整理好，输出中文'])
})

test(`at most ${MAX_RUNNING} tasks work at once: one more is refused, not queued, by the agent and by 后台做 alike`, async () => {
  const { tasks, call, ends } = setup()
  const ids = []
  for (let i = 0; i < MAX_RUNNING; i++) ids.push((await tasks.agent.start(`任务 ${i}`)).taskId)
  await assert.rejects(tasks.agent.start('再来一个'), /最多 5 个/)
  assert.match((await call<{ ok: boolean, problem: string }>('task:start', { text: '后台做一个' })).problem, /最多 5 个/)
  ends(ids[0])
  assert.equal((await tasks.agent.start('现在可以了')).status, 'running', 'one ended: room for another')
})

test('the agent messages a task: into its turn while it works, its next question once it ended', async () => {
  const { tasks, calls, announced, says, ends, texts, kept, snapshots } = setup()
  const { taskId } = await tasks.agent.start('整理发布说明')
  assert.deepEqual(await tasks.agent.message(taskId, '加上版本号'), { taskId, delivered: 'into its turn' })
  assert.deepEqual(calls.at(-1), ['steerTask', taskId, '加上版本号'])
  says(taskId, '写好了')
  ends(taskId)
  assert.deepEqual(await tasks.agent.message(taskId, '再加上已知问题'), { taskId, delivered: 'next question' })
  assert.deepEqual(calls.at(-1), ['promptTask', taskId, '再加上已知问题'])
  assert.deepEqual(announced.map((event) => event.type), ['task_steered'], 'into its turn: said; a new run comes by its snapshot')
  assert.equal(snapshots.findLast((snapshot) => snapshot.opening)?.opening?.words, '再加上已知问题')
  ends(taskId)
  assert.deepEqual(texts(kept()[0].segmentId), ['整理发布说明', '加上版本号', '写好了', '再加上已知问题', '本轮没有文字回复。'])
})

test('a message to a task an earlier launch left unfinished takes it up again with those words', async () => {
  const { tasks, says, relaunch } = setup()
  const { taskId } = await tasks.agent.start('整理发布说明')
  says(taskId, '先看提交…')
  tasks.dsh.flush()
  const later = relaunch()
  assert.deepEqual(await later.tasks.agent.message(taskId, '接着做，写完为止'), { taskId, delivered: 'taken up again' })
  assert.deepEqual(later.calls, [['resumeTask', taskId], ['promptTask', taskId, '接着做，写完为止']])
})

test('the agent stops a task at work; one that ended or is not held says so; one unknown is refused', async () => {
  const { tasks, calls, ends } = setup()
  const { taskId } = await tasks.agent.start('整理发布说明')
  assert.deepEqual(await tasks.agent.stop(taskId), { taskId, stopped: true })
  assert.deepEqual(calls.at(-1), ['cancelTask', taskId])
  ends(taskId, 'cancelled')
  assert.deepEqual(await tasks.agent.stop(taskId), { taskId, stopped: false, status: 'stopped' })
  await assert.rejects(tasks.agent.stop('nobody'), /接不上/)
  await assert.rejects(tasks.agent.message('nobody', '在吗'), /接不上/)
})

test('words that do not reach a task at work are said so, not taken for delivered', async () => {
  const { tasks } = setup({ steerable: false })
  const { taskId } = await tasks.agent.start('整理发布说明')
  await assert.rejects(tasks.agent.message(taskId, '加上版本号'), /话没有送到/)
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
  const { tasks, calls, ends } = setup()
  const { taskId } = await tasks.agent.start('整理发布说明')
  ends(taskId, 'error')
  tasks.dsh.gone()
  assert.deepEqual(await tasks.agent.message(taskId, '接着做'), { taskId, delivered: 'next question' })
  assert.deepEqual(calls.slice(-2), [['resumeTask', taskId], ['promptTask', taskId, '接着做']])
})

test('an answer is kept even though dsh closes the question as it takes the answer', async () => {
  const { call, tasks, ends, texts } = setup()
  const { task } = await call<Started>('task:start', { text: '查一下明天的天气' })
  const city = { id: 'city', question: '哪个城市？', options: [{ label: '上海' }, { label: '北京' }] }
  tasks.dsh.receive({ type: 'task_question', taskId: task.id, questionId: 'q1', questions: [city] })
  // As compose.ts does: held, then dsh takes the answer (and says the question closed), then kept.
  const keep = tasks.dsh.holdQuestion('q1')
  tasks.dsh.receive({ type: 'task_question_closed', taskId: task.id, questionId: 'q1' })
  keep?.([{ id: 'city', selected: ['北京'] }])
  ends(task.id)
  assert.deepEqual(texts(task.segmentId), ['查一下明天的天气', '北京', '本轮没有文字回复。'])
  assert.equal(tasks.dsh.holdQuestion('q-unknown'), null)
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
  const { call, tasks } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  const stream = (kind: string, extra: object) => tasks.dsh.receive({ type: 'task_update', taskId: task.id, update: { sessionUpdate: 'viva_stream', key: 'k1', kind, ...extra } })
  stream('delta', { index: 0, blockType: 'text', text: '前半段' })
  const state = reduce(initialState, { type: 'tasks_restored', list: await call<Kept[]>('task:finished') })
  const next = reduce(state, { type: 'task_update', taskId: task.id, at: 9, update: { sessionUpdate: 'viva_stream', key: 'k1', kind: 'delta', index: 0, blockType: 'text', text: '后半段' } })
  const settled = reduce(next, { type: 'task_update', taskId: task.id, at: 10, update: { sessionUpdate: 'viva_stream', key: 'k1', kind: 'settle', blocks: [{ type: 'text', text: '前半段后半段' }] } })
  assert.deepEqual(settled.tasks.list[0].view.messages.map((m: { text: string }) => m.text), ['整理发布说明', '前半段后半段'])
})

test('a stream with words said into it, then a reload, still settles into one message', async () => {
  const { call, tasks } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  const update = (kind: string, extra: object) => ({ sessionUpdate: 'viva_stream', key: 'k1', kind, ...extra })
  tasks.dsh.receive({ type: 'task_update', taskId: task.id, update: update('delta', { index: 0, blockType: 'text', text: '前半段' }) })
  await tasks.agent.message(task.id, '用户补充')
  const state = reduce(initialState, { type: 'tasks_restored', list: await call<Kept[]>('task:finished') })
  const more = reduce(state, { type: 'task_update', taskId: task.id, at: 9, update: update('delta', { index: 0, blockType: 'text', text: '后半段' }) })
  const settled = reduce(more, { type: 'task_update', taskId: task.id, at: 10, update: update('settle', { blocks: [{ type: 'text', text: '前半段后半段' }] }) })
  assert.deepEqual(settled.tasks.list[0].view.messages.map((m: { text: string }) => m.text), ['整理发布说明', '前半段后半段', '用户补充'])
})

test('an answer streamed and settled, then a reload, then the turn falling back to plain text: one answer, not two', async () => {
  const { call, tasks } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  const update = (kind: string, extra: object) => ({ sessionUpdate: 'viva_stream', key: 'k1', kind, ...extra })
  const says = (raw: object) => tasks.dsh.receive({ type: 'task_update', taskId: task.id, update: raw })
  says(update('delta', { index: 0, blockType: 'text', text: '回答' }))
  says(update('settle', { blocks: [{ type: 'text', text: '回答' }] }))
  const state = reduce(initialState, { type: 'tasks_restored', list: await call<Kept[]>('task:finished') })
  // The stream channel's last flush did not come back (assistant-stream.ts complete): its keys withdrawn, then the ACP text.
  const fallback = [update('settle', { blocks: [] }), { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '回答' } }]
  fallback.forEach(says)
  const shown = fallback.reduce((current, raw, i) => reduce(current, { type: 'task_update', taskId: task.id, at: 10 + i, update: raw }), state)
  assert.deepEqual(shown.tasks.list[0].view.messages.map((m: { text: string }) => m.text), ['整理发布说明', '回答'], 'the window')
  tasks.dsh.flush()
  const [kept] = await call<Kept[]>('task:finished')
  assert.deepEqual(kept.messages.map((m) => m.text), ['整理发布说明', '回答'], 'and what is kept')
})

test('the window\'s order: the snapshot that begins a run first, then each piece numbered with its run, each snapshot after the pieces it includes', async () => {
  const { call, says, ends, pushes, emit, tasks } = setup()
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  says(task.id, '先看提交…')
  emit({ type: 'task_question', taskId: task.id, questionId: 'q1', questions: [] })
  ends(task.id)
  await tasks.agent.message(task.id, '再加上已知问题')
  says(task.id, '加好了')
  const mine = pushes.filter((push) => push.taskId === task.id)
  const line = (push: TaskPush) => push.type === 'task_snapshot'
    ? `snapshot ${(push as { snapshot: WindowSnapshot }).snapshot.runId} ≤${(push as { snapshot: WindowSnapshot }).snapshot.taskSeq}${(push as { snapshot: WindowSnapshot }).snapshot.opening ? ' begins' : ''}`
    : `${push.type} ${(push as TaskPiece).runId} #${(push as TaskPiece).taskSeq}`
  const shown = mine.map(line)
  assert.equal(shown[0], 'snapshot run-1 ≤0 begins', 'made before anything it says')
  assert.deepEqual(shown.filter((entry) => !entry.startsWith('snapshot')), ['task_update run-1 #1', 'task_question run-1 #2', 'task_end run-1 #3', 'task_update run-2 #4'],
    'numbered in order, one count across its runs')
  const firstOfRun2 = shown.indexOf('task_update run-2 #4')
  assert.ok(shown.slice(0, firstOfRun2).includes('snapshot run-2 ≤3 begins'), 'the new run begins before its first piece')
  const asking = mine.find((push) => push.type === 'task_snapshot' && (push as { snapshot: WindowSnapshot }).snapshot.waitingFor === 'answer')
  assert.equal((asking as { snapshot: WindowSnapshot } | undefined)?.snapshot.taskSeq, 2, 'the snapshot waiting on the answer includes the question that made it so')
  for (const [i, entry] of shown.entries()) {
    const said = /≤(\d+)/.exec(entry)
    if (said) assert.equal(Number(said[1]), shown.slice(0, i).filter((before) => before.includes('#')).length, `${entry}: includes the pieces before it, no more`)
  }
})

test('what dsh says of a task unknown, or no longer at work, goes nowhere; the window opening gets each task\'s mark', async () => {
  const { call, says, ends, pushes, emit } = setup()
  emit({ type: 'task_update', taskId: 'nobody', update: chunk('谁的？') })
  emit({ type: 'task_question', taskId: 'nobody', questionId: 'q1', questions: [] })
  assert.deepEqual(pushes.filter((push) => push.taskId === 'nobody'), [], 'no task\'s: nothing waits for it to be known')
  const { task } = await call<Started>('task:start', { text: '整理发布说明' })
  says(task.id, '写好了')
  ends(task.id)
  const before = pushes.length
  says(task.id, '结束之后又说的')
  assert.equal(pushes.length, before, 'ended: what comes after is no run\'s')
  const [kept] = await call<Array<{ mark?: { runId: string, seq: number } }>>('task:finished')
  assert.deepEqual([kept.mark?.runId, kept.mark?.seq, typeof (kept.mark as { revision?: unknown })?.revision], ['run-1', 2, 'number'], 'what it said, up to its end, and how many times it changed')
})

const refusal = (promise: Promise<unknown>) => promise.then(() => 'ok', (err: Error) => err.message)

test(`runs begun together: no more than ${MAX_RUNNING} pass, the place counted before anything is awaited`, async () => {
  const { tasks } = setup()
  const results = await Promise.all(Array.from({ length: MAX_RUNNING + 1 }, (_, i) => refusal(tasks.agent.start(`任务 ${i}`))))
  assert.equal(results.filter((result) => result === 'ok').length, MAX_RUNNING)
  assert.match(results.find((result) => result !== 'ok') ?? '', /最多 5 个/)
})

test(`${MAX_RUNNING} at work: a task asked again, or taken up, waits its turn like a new one`, async () => {
  const { tasks, says, ends, relaunch } = setup()
  const { taskId: done } = await tasks.agent.start('先做完的')
  ends(done)
  const { taskId: unfinished } = await tasks.agent.start('没做完的')
  says(unfinished, '先看…')
  tasks.dsh.flush()
  const later = relaunch()
  await later.call('task:finished')
  for (let i = 0; i < MAX_RUNNING; i++) await later.tasks.agent.start(`任务 ${i}`)
  await assert.rejects(later.tasks.agent.message(done, '再加一条'), /最多 5 个/, 'asked again: refused while full')
  await assert.rejects(later.tasks.agent.message(unfinished, '接着做'), /最多 5 个/, 'taken up: refused while full')
})

test('one task, one new run at a time: asked again twice at once, the second is told it is going', async () => {
  const { tasks, ends, relaunch } = setup()
  const { taskId } = await tasks.agent.start('整理发布说明')
  ends(taskId)
  const later = relaunch()
  await later.call('task:finished')
  // Not held by this launch: asking it takes up its session first (awaited), so the two asks overlap.
  const [first, second] = await Promise.all([refusal(later.tasks.agent.message(taskId, '再加一条')), refusal(later.tasks.agent.message(taskId, '再加两条'))])
  assert.equal(first, 'ok')
  assert.notEqual(second, 'ok', 'the second does not take the same session for a turn of its own')
  assert.deepEqual(later.calls.filter(([kind]) => kind === 'promptTask').map(([, , text]) => text), ['再加一条'])
})

test('a run that could not begin gives its place back: refused by dsh, the places are as before', async () => {
  let fails = 2
  const { tasks } = setup({ startable: () => fails-- <= 0 })
  for (let i = 0; i < 2; i++) await assert.rejects(tasks.agent.start(`失败 ${i}`))
  const results = await Promise.all(Array.from({ length: MAX_RUNNING }, (_, i) => refusal(tasks.agent.start(`任务 ${i}`))))
  assert.deepEqual(results, Array(MAX_RUNNING).fill('ok'), 'all five places free again')
})

test('a run whose beginning throws (dsh gone mid-way) gives its place back too', async () => {
  let fails = 2
  const { tasks } = setup({ startable: () => { if (fails-- > 0) throw new Error('dsh went away'); return true } })
  for (let i = 0; i < 2; i++) await assert.rejects(tasks.agent.start(`失败 ${i}`), /dsh went away/)
  const results = await Promise.all(Array.from({ length: MAX_RUNNING }, (_, i) => refusal(tasks.agent.start(`任务 ${i}`))))
  assert.deepEqual(results, Array(MAX_RUNNING).fill('ok'))
})

test('a run kept is counted once: its place goes to the registry as its start commits, not a step later', async () => {
  const gates: Array<() => void> = []
  let fifth: Promise<string> | null = null
  const { tasks } = setup({
    gate: () => new Promise<void>((resolve) => { gates.push(resolve) }),
    // Just after the first is kept, before anything after it runs: one more is begun.
    onPrompt: () => { fifth ??= refusal(tasks.agent.start('第五个')) },
  })
  const four = Array.from({ length: 4 }, (_, i) => refusal(tasks.agent.start(`任务 ${i}`)))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(gates.length, 4, 'four waiting on dsh')
  gates[0]()
  await new Promise((resolve) => setTimeout(resolve, 0))
  gates.slice(1).forEach((open) => open())
  gates.at(-1)?.()
  await new Promise((resolve) => setTimeout(resolve, 0))
  gates.forEach((open) => open())
  assert.ok(fifth, 'the fifth was begun as the first was kept')
  assert.deepEqual(await Promise.all(four), ['ok', 'ok', 'ok', 'ok'])
  assert.equal(await fifth, 'ok', 'four places taken, not five: the fifth has one')
})
