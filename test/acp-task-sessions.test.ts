import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NewSessionResponse, ResumeSessionResponse, SessionConfigOption, SetSessionConfigOptionRequest } from '@agentclientprotocol/sdk'
import { createAcpTaskSessions } from '../src/backend/acp-task-sessions.ts'

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const select = (value: string): SessionConfigOption => ({ id: 'model', name: 'Model', type: 'select', currentValue: value, options: [{ value, name: value }] })
const toggle = (value: boolean): SessionConfigOption => ({ id: 'flag', name: 'Flag', type: 'boolean', currentValue: value })
function harness(overrides: Partial<Parameters<typeof createAcpTaskSessions>[0]> = {}) {
  const closed: string[] = [], configured: SetSessionConfigOptionRequest[] = [], events: object[] = []
  let returnedFlag = false
  let source: readonly SessionConfigOption[] = [select('chosen'), toggle(true)], prepares = 0
  const sessions = createAcpTaskSessions({
    connection: () => ({ closeSession: async request => { closed.push(request.sessionId); return {} }, setSessionConfigOption: async request => { configured.push(request); if ('type' in request && request.type === 'boolean') returnedFlag = request.value; return { configOptions: [select('chosen'), toggle(returnedFlag)] } } }),
    acquire: { fresh: async () => ({ sessionId: 'task', configOptions: [select('default'), toggle(false)] }), resume: async () => ({ configOptions: [select('default')] }) },
    foreground: () => ({ sessionId: 'main', cwd: '/origin', config: source }), canResume: () => true, prepareFresh: () => { prepares++ },
    operations: { run: async () => {}, cancelInTime: async () => true, count: () => 0 },
    permissions: { pendingFor: () => [], waitingSessions: () => new Set() }, questions: { declineTask: () => {}, pendingOf: () => [] },
    steer: async () => ({ ok: true }), emit: event => { events.push(event) }, describeError: String, goneMessage: () => 'gone', stoppedMessage: () => 'stopped',
    ...overrides,
  })
  return { sessions, closed, configured, events, prepares: () => prepares, source: (value: readonly SessionConfigOption[]) => { source = value } }
}

test('task configuration and directory are captured before its fresh session arrives, including boolean options', async () => {
  const fresh = deferred<NewSessionResponse>(), dirs: string[] = []
  const h = harness({ acquire: { fresh: cwd => { dirs.push(cwd); return fresh.promise }, resume: async () => ({}) } })
  const original = select('chosen'); h.source([original, toggle(true)])
  const pending = h.sessions.startTask(); original.currentValue = 'mutated'; h.source([select('later'), toggle(false)])
  fresh.resolve({ sessionId: 'task', configOptions: [select('default'), toggle(false)] })
  assert.deepEqual(await pending, { ok: true, taskId: 'task' })
  assert.deepEqual(dirs, ['/origin'])
  assert.deepEqual(h.configured, [{ sessionId: 'task', configId: 'model', value: 'chosen' }, { sessionId: 'task', configId: 'flag', type: 'boolean', value: true }])
  assert.equal(h.sessions.has('task'), true)
})

for (const mode of ['fresh', 'resume'] as const) test(`disposal revokes in-flight ${mode} acquisition and releases its late native session`, async () => {
  const gate = deferred<NewSessionResponse>(), h = harness({ acquire: { fresh: () => gate.promise, resume: () => gate.promise } })
  const pending = mode === 'fresh' ? h.sessions.startTask() : h.sessions.resumeTask({ taskId: 'task' })
  await new Promise<void>(resolve => setImmediate(resolve))
  h.sessions.dispose(); gate.resolve({ sessionId: 'task' })
  assert.equal((await pending).ok, false)
  assert.equal(h.sessions.has('task'), false); assert.deepEqual(h.closed, ['task']); assert.equal(h.prepares(), 0)
})

test('an unattended task is one nobody answers for; taken up again under the same id it is an ordinary task', async () => {
  const h = harness()
  assert.deepEqual(await h.sessions.startUnattendedTask({ cwd: '/scheduled' }), { ok: true, taskId: 'task' })
  assert.equal(h.sessions.isUnattended('task'), true)
  await h.sessions.closeTask('task')
  assert.equal(h.sessions.isUnattended('task'), false)
  await h.sessions.resumeTask({ taskId: 'task' })
  assert.equal(h.sessions.has('task'), true)
  assert.equal(h.sessions.isUnattended('task'), false)
})

test('failed model matching retires the unreported session instead of keeping a native attachment', async t => {
  t.mock.method(console, 'error', () => {})
  const closed: string[] = [], h = harness({ connection: () => ({ closeSession: async request => { closed.push(request.sessionId); return {} }, setSessionConfigOption: async () => { throw new Error('no such option') } }) })
  assert.equal((await h.sessions.startTask()).ok, false)
  assert.deepEqual(closed, ['task']); assert.equal(h.sessions.has('task'), false); assert.deepEqual(h.events, [])
})

test('closing a saved task revokes its pending native resume instead of attaching after the user closed it', async () => {
  const resume = deferred<ResumeSessionResponse>(), h = harness({ acquire: { fresh: async () => ({ sessionId: 'unused' }), resume: () => resume.promise } })
  const pending = h.sessions.resumeTask({ taskId: 'saved' })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.sessions.has('saved'), false)
  await h.sessions.closeTask('saved'); resume.resolve({})
  assert.equal((await pending).ok, false)
  assert.equal(h.sessions.has('saved'), false)
  assert.deepEqual(h.closed, ['saved'])
})

test('an old configuration rejection cannot delete or close a newer attachment of the same native id', async t => {
  t.mock.method(console, 'error', () => {})
  const config = deferred<{ configOptions: SessionConfigOption[] }>(), closed: string[] = []
  const h = harness({ connection: () => ({ setSessionConfigOption: () => config.promise, closeSession: async request => { closed.push(request.sessionId); return {} } }) })
  const pending = h.sessions.startTask()
  await new Promise<void>(resolve => setImmediate(resolve))
  await h.sessions.closeTask('task')
  assert.equal((await h.sessions.resumeTask({ taskId: 'task' })).ok, true)
  config.reject(new Error('old configuration failed'))
  assert.equal((await pending).ok, false)
  assert.equal(h.sessions.has('task'), true)
  assert.deepEqual(closed, ['task'])
})

test('a reattachment waits for the previous native close and cannot have its permissions cancelled by old cleanup', async () => {
  const close = deferred<object>(), log: string[] = []
  const h = harness({
    connection: () => ({ setSessionConfigOption: async () => ({ configOptions: [select('chosen'), toggle(true)] }), closeSession: async () => { log.push('closing'); await close.promise; log.push('closed'); return {} } }),
    acquire: { fresh: async () => ({ sessionId: 'task' }), resume: async () => { log.push('resume'); return {} } },
    questions: { declineTask: () => { log.push('decline-old') }, pendingOf: () => [] },
  })
  await h.sessions.startTask()
  const closing = h.sessions.closeTask('task'), pending = h.sessions.resumeTask({ taskId: 'task' })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(log, ['decline-old', 'closing'])
  close.resolve({}); await closing
  assert.equal((await pending).ok, true)
  assert.deepEqual(log, ['decline-old', 'closing', 'closed', 'resume'])
})

test('task prompts deliver the exact owner-bound wire text and closing during alias binding revokes delivery', async () => {
  const gate = deferred<string>(), sent: unknown[] = []
  const h = harness({ preparePrompt: () => gate.promise,
    operations: { run: async request => { sent.push(request.prompt) }, cancelInTime: async () => true, count: () => 0 } })
  await h.sessions.startTask()
  const prompt = h.sessions.promptTask('task', 'generated brief')
  gate.resolve('delivery-token\ngenerated brief')
  await prompt
  assert.deepEqual(sent.slice(), [[{ type: 'text', text: 'delivery-token\ngenerated brief' }]])

  const closingGate = deferred<string>()
  const other = harness({ preparePrompt: () => closingGate.promise,
    operations: { run: async request => { sent.push(request.prompt) }, cancelInTime: async () => true, count: () => 0 } })
  await other.sessions.startTask()
  const revoked = other.sessions.promptTask('task', 'same brief')
  await other.sessions.closeTask('task')
  closingGate.resolve('other-token\nsame brief')
  await revoked
  assert.equal(sent.length, 1)
})

test('task prompts forward pasted image blocks ahead of text and preserve image refs across task runtime saves', async (t) => {
  const sent: unknown[] = []
  const h = harness({
    operations: { run: async request => { sent.push(request.prompt) }, cancelInTime: async () => true, count: () => 0 },
  })
  await h.sessions.startTask()
  await h.sessions.promptTask('task', 'inspect screenshot', { origin: 'router' }, [{ data: 'QUJD', mimeType: 'image/png' }])
  assert.deepEqual(sent, [[
    { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    { type: 'text', text: 'inspect screenshot' },
  ]])

  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { openAppDb } = await import('../src/backend/app-db.ts')
  const { openHistoryDb } = await import('../src/backend/history-db.ts')
  const { createTaskStore } = await import('../src/backend/task-store.ts')
  const { createTaskRuntime } = await import('../src/backend/task-runtime.ts')

  const dir = mkdtempSync(path.join(tmpdir(), 'task-img-rt-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const app = openAppDb({ file: path.join(dir, 'app.db') })
  t.after(() => app.close())
  const db = openHistoryDb({ db: app.db })
  const store = createTaskStore({ db: app.db })
  const main = db.create({ sessionId: 'main-s', mode: 'live', model: 'm', cwd: '/work' })
  const taskPrompts: Array<{ taskId: string, text: string, images: unknown }> = []
  let nextTask = 0
  const runtime = createTaskRuntime({
    db,
    store,
    current: () => main,
    agentInfo: () => ({ mode: 'live', model: 'm' }),
    agent: {
      startTask: async () => ({ ok: true, taskId: `task-${++nextTask}` }),
      promptTask: (taskId, text, _meta, images) => { taskPrompts.push({ taskId, text, images }) },
      steerTask: async () => ({ ok: true }),
      resumeTask: async () => ({ ok: true }),
      cancelTask: () => {},
      closeTask: () => {},
    },
  })
  const imageId = `${'b'.repeat(64)}.png`
  const imgs = { refs: [{ id: imageId }], payloads: [{ data: 'QUJD', mimeType: 'image/png' }] }
  const started = await runtime.agent.start('对照截图查错', '查错', undefined, imgs)
  assert.equal(taskPrompts.length, 1)
  assert.deepEqual(taskPrompts[0]?.images, imgs.payloads)

  await assert.rejects(
    runtime.agent.message(started.taskId, '再补一张图', undefined, imgs),
    /正在运行|running/i,
  )

  runtime.dsh.receive({ type: 'task_update', taskId: started.taskId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已修复' } } })
  runtime.dsh.receive({ type: 'task_end', taskId: started.taskId, stopReason: 'end_turn' })
  const secondImageId = `${'c'.repeat(64)}.png`
  const secondImgs = { refs: [{ id: secondImageId }], payloads: [{ data: 'REVG', mimeType: 'image/png' }] }
  await runtime.agent.message(started.taskId, '对照新图复核', undefined, secondImgs)
  runtime.dsh.receive({ type: 'task_end', taskId: started.taskId, stopReason: 'end_turn' })

  const finished = runtime.window.finished().find(entry => entry.task.id === started.taskId)
  assert.ok(finished)
  const userMessages = finished.messages.filter(m => m.role === 'user')
  assert.deepEqual(userMessages.map(m => m.images), [[{ id: imageId }], [{ id: secondImageId }]])

  // Simulate restart + resume of an interrupted task before any chunk arrives: the image message must already be in SQLite.
  const started2 = await runtime.agent.start('初始中断任务', '中断任务')
  const runtimeAfterRestart = createTaskRuntime({
    db,
    store,
    current: () => main,
    agentInfo: () => ({ mode: 'live', model: 'm' }),
    agent: {
      startTask: async () => ({ ok: true, taskId: `task-${++nextTask}` }),
      promptTask: (taskId, text, _meta, images) => { taskPrompts.push({ taskId, text, images }) },
      steerTask: async () => ({ ok: true }),
      resumeTask: async () => ({ ok: true }),
      cancelTask: () => {},
      closeTask: () => {},
    },
  })
  const thirdImageId = `${'d'.repeat(64)}.png`
  const thirdImgs = { refs: [{ id: thirdImageId }], payloads: [{ data: 'R0hJ', mimeType: 'image/png' }] }
  await runtimeAfterRestart.agent.message(started2.taskId, '恢复并附带新图', undefined, thirdImgs)
  const entry2 = store.list().find(item => item.id === started2.taskId)!
  const persistedMessages = db.get(entry2.segmentId)?.messages ?? []
  assert.deepEqual(persistedMessages.map(m => m.images), [undefined, [{ id: thirdImageId }]], 'resumed message and images persist atomically in SQLite')

  const { initialState, reduce: windowReduce } = await import('../src/renderer/state.ts')
  const madeState = windowReduce(initialState, {
    type: 'task_snapshot',
    snapshot: {
      taskId: 't-img',
      runId: 'run-1',
      title: '看图',
      status: 'running',
      currentAction: null,
      waitingFor: null,
      startedAt: 10,
      updatedAt: 10,
      endedAt: null,
      resultPreview: '',
      revision: 1,
      taskSeq: 0,
      opening: {
        words: '请看这张图',
        images: [{ id: imageId }],
        task: { id: 't-img', segmentId: 'seg-img', title: '看图', words: '请看这张图' },
        hostSession: null,
      },
    },
  })
  assert.deepEqual(madeState.tasks.list[0]!.view.messages.map(m => m.images), [[{ id: imageId }]])
  const restoredState = windowReduce(initialState, {
    type: 'tasks_restored',
    list: [{
      task: { id: 't-restored', segmentId: 'seg-r', title: '历史图', words: '历史图' },
      status: 'done',
      endedAt: 20,
      messages: [{ role: 'user', text: '历史图', images: [{ id: secondImageId }], receipt: null }],
    }],
  })
  assert.deepEqual(restoredState.tasks.list[0]!.view.messages.map(m => m.images), [[{ id: secondImageId }]])
})
