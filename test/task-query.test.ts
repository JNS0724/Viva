import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createTaskRegistry, parseTaskQuery } from '../src/backend/task-registry.ts'
import { createTasksDesk, parseTaskAction } from '../src/backend/tasks-channel.ts'
import { createTasksChannel } from '../plugins/tasks/lib/channel.ts'
import { initialState, reduce } from './fixtures/task-window.ts'

test('task projection tracks simultaneous waits, tools, streamed output and terminal state without a renderer', () => {
  let time = 10
  const registry = createTaskRegistry({ now: () => time++ })
  registry.put({ id: 'a', title: '整理', cwd: '/work', words: '原始请求' })
  const get = () => registry.query({ op: 'get', taskId: 'a', includeOutput: true, includeRequest: true }, { taskId: 'a' }).task!
  const event = (type: string, extra: object = {}) => registry.receive({ type, taskId: 'a', ...extra })
  event('task_update', { update: { sessionUpdate: 'tool_call', toolCallId: 't', title: '读取文件', status: 'in_progress' } })
  assert.equal(get().currentAction, '读取文件')
  event('permission', { requestId: 'p' }); event('task_question', { questionId: 'q' })
  assert.equal(get().waitingFor, 'permission')
  event('task_permission_closed', { requestId: 'p' })
  assert.equal(get().waitingFor, 'answer')
  event('task_question_closed', { questionId: 'q' })
  assert.equal(get().status, 'running')
  event('task_update', { update: { sessionUpdate: 'viva_stream', key: 's', kind: 'delta', index: 0, blockType: 'text', text: '结果' } })
  event('task_update', { update: { sessionUpdate: 'viva_stream', key: 's', kind: 'block', index: 0, blockType: 'text', text: '结果' } })
  assert.equal(get().resultPreview, '结果', 'block completion replaces deltas instead of duplicating them')
  event('task_end', { stopReason: 'end_turn' })
  const ended = get()
  assert.equal(ended.status, 'done'); assert.equal(ended.request, '原始请求'); assert.ok(ended.endedAt)
  event('task_question', { questionId: 'late' })
  assert.deepEqual(get(), ended, 'late events cannot resurrect a terminal task')
})

test('restored and disconnected tasks are interrupted until explicitly resumed; retained results stay readable', () => {
  const registry = createTaskRegistry()
  registry.put({ id: 'a', title: 'old', cwd: '/work' }, true)
  const get = () => registry.query({ op: 'get', taskId: 'a' }, { taskId: 'a' }).task!
  assert.equal(get().status, 'interrupted')
  registry.restart('a'); assert.equal(get().status, 'running')
  registry.interrupt(); assert.equal(get().status, 'interrupted')
  registry.put({ id: 'b', title: 'finished', endedAt: 100, status: 'done', resultPreview: '已完成' }, true)
  assert.equal(registry.query({ op: 'get', taskId: 'b', includeOutput: true }, { taskId: 'b' }).task!.resultPreview, '已完成')
})

test('what is said of a task not known yet is no task\'s: nothing waits for it, and the task once made starts clean', () => {
  const registry = createTaskRegistry()
  registry.receive({ type: 'task_question', taskId: 'a', questionId: 'q' })
  registry.receive({ type: 'task_end', taskId: 'b', stopReason: 'cancelled' })
  registry.put({ id: 'a', title: 'task' })
  registry.put({ id: 'b', title: 'task' })
  assert.equal(registry.query({ op: 'get', taskId: 'a' }, { taskId: 'a' }).task!.status, 'running')
  assert.equal(registry.query({ op: 'get', taskId: 'b' }, { taskId: 'b' }).task!.status, 'running')
})

test('queries let main see all workspaces with optional cwd filter, keep background callers self-only, paginate, and omit request/output by default', () => {
  const registry = createTaskRegistry()
  for (const [id, cwd] of [['a', '/one'], ['b', '/one'], ['c', '/two']]) registry.put({ id: id!, cwd, title: id!, words: 'private' })
  const list = registry.query({ op: 'list', limit: 1 }, { kind: 'main', cwd: '/one' })
  assert.equal(list.total, 3); assert.equal(list.tasks!.length, 1); assert.equal(list.nextOffset, 1)
  assert.equal(JSON.stringify(list).includes('private'), false)
  assert.ok(list.tasks![0]!.cwd)
  const onlyOne = registry.query({ op: 'list', cwd: '/one' }, { kind: 'main', cwd: '/two' })
  assert.equal(onlyOne.total, 2)
  assert.deepEqual(onlyOne.tasks!.map(task => task.cwd), ['/one', '/one'])
  const crossGet = registry.query({ op: 'get', taskId: 'c' }, { kind: 'main', cwd: '/one' })
  assert.equal(crossGet.task!.taskId, 'c')
  assert.equal(crossGet.task!.cwd, '/two')
  assert.equal(registry.query({ op: 'list' }, { taskId: 'a' }).total, 1)
  assert.throws(() => registry.query({ op: 'get', taskId: 'b' }, { taskId: 'a' }), /不存在/)
  registry.remove('a'); assert.equal(registry.query({ op: 'list' }, { taskId: 'a' }).total, 0)
  assert.equal(parseTaskQuery({ op: 'list', limit: 100, cwd: ' /one ' }).limit, 30)
  assert.equal(parseTaskQuery({ op: 'list', cwd: ' /one ' }).cwd, '/one')
  for (const request of [{ op: 'stop' }, { op: 'get' }, { op: 'list', offset: -1 }, { op: 'list', includeOutput: 'yes' }, { op: 'list', status: 'fake' }, { op: 'list', cwd: '   ' }, { op: 'list', cwd: 123 }]) assert.throws(() => parseTaskQuery(request))
})

test('plugin IPC carries session identity, rejects stale sessions, and returns structured query data', async () => {
  const port = new EventEmitter()
  const registry = createTaskRegistry(); registry.put({ id: 'a', title: 'task' })
  const desk = createTasksDesk({ send: message => port.emit('message', message), authorized: id => id === 'a', read: (request, sessionId) => registry.query(request, { taskId: sessionId }) })
  const channel = createTasksChannel({ send: message => desk.receive(message), on: port.on.bind(port), off: port.off.bind(port) })
  const result = JSON.parse(await channel.request({ op: 'list' }, 'a')) as { tasks: { taskId: string }[] }
  assert.equal(result.tasks[0]!.taskId, 'a')
  await assert.rejects(channel.request({ op: 'list' }, 'old'), /会话已失效/)
  channel.close(); assert.equal(port.listenerCount('message'), 0)
})

test('query IPC cleans up on abort, timeout, disconnect, malformed response and send failure', async () => {
  const port = new EventEmitter()
  let sent: Record<string, unknown> = {}
  const channel = createTasksChannel({ send: message => { sent = message as Record<string, unknown> }, on: port.on.bind(port), off: port.off.bind(port) }, 10)
  const controller = new AbortController()
  const aborted = channel.request({}, 'a', controller.signal); controller.abort()
  await assert.rejects(aborted, /取消/)
  await assert.rejects(channel.request({}, 'a'), /超时/)
  const malformed = channel.request({}, 'a')
  port.emit('message', { type: 'tasks_result', id: sent.id, ok: true, text: 123 })
  await assert.rejects(malformed, /无效/)
  const disconnected = channel.request({}, 'a'); channel.close()
  await assert.rejects(disconnected, /断开/)
  await assert.rejects(channel.request({}, 'a'), /断开/)
  const broken = createTasksChannel({ send: () => { throw Error('broken') }, on: port.on.bind(port), off: port.off.bind(port) })
  await assert.rejects(broken.request({}, 'a'), /broken/); broken.close()
})

test('text updates remain queryable without duplicate UI refreshes; status snapshots reach task cards', () => {
  const snapshots: string[] = []
  const registry = createTaskRegistry({ changed: snapshot => snapshots.push(snapshot.status) })
  registry.put({ id: 'a', title: 'task' })
  for (let i = 0; i < 100; i++) registry.receive({ type: 'task_update', taskId: 'a', update: { sessionUpdate: 'agent_message_chunk', content: { text: '字' } } })
  assert.deepEqual(snapshots, ['running'])
  assert.equal(registry.query({ op: 'get', taskId: 'a', includeOutput: true }, { taskId: 'a' }).task!.resultPreview!.length, 100)
  registry.interrupt(); assert.deepEqual(snapshots, ['running', 'interrupted'])
  const started = reduce(initialState, { type: 'task_started', task: { id: 'a', title: 'task' }, text: 'do', at: 1 })
  const snapshot = registry.query({ op: 'get', taskId: 'a' }, { taskId: 'a' }).task!
  const interrupted = reduce(started, { type: 'task_snapshot', snapshot: { ...snapshot, resultPreview: snapshot.resultPreview ?? '', taskSeq: 0 } })
  assert.equal(interrupted.tasks.list[0]!.status, 'interrupted')
  assert.equal(interrupted.tasks.list[0]!.now, null)
})

test('the agent\'s schedule changes travel the same channel: checked, carried out by the app, their result or refusal returned', async () => {
  const port = new EventEmitter()
  const acted: unknown[] = []
  const desk = createTasksDesk({
    send: message => port.emit('message', message), authorized: id => id === 'main', read: () => ({ observedAt: 0, tasks: [], total: 0, nextOffset: null }),
    act: async (request, sessionId) => {
      acted.push([request, sessionId])
      if (request.op === 'schedule_delete') throw new Error('没有这个定时任务')
      return { id: 's1' }
    },
  })
  const channel = createTasksChannel({ send: message => desk.receive(message), on: port.on.bind(port), off: port.off.bind(port) })
  assert.deepEqual(JSON.parse(await channel.request({ op: 'schedule_list', extra: 1 }, 'main')), { id: 's1' })
  assert.deepEqual(acted, [[{ op: 'schedule_list' }, 'main']], 'the request arrives as parsed')
  await assert.rejects(channel.request({ op: 'schedule_delete', id: 's9' }, 'main'), /没有这个定时任务/)
  await assert.rejects(channel.request({ op: 'schedule_update', title: '无 id' }, 'main'))
  await assert.rejects(channel.request({ op: 'schedule_list' }, 'old'), /会话已失效/)
  assert.equal(acted.length, 2, 'nothing malformed or from a stale session reaches the app')
  const readOnly = createTasksDesk({ send: message => port.emit('message', message), authorized: () => true, read: () => ({ observedAt: 0, tasks: [], total: 0, nextOffset: null }) })
  const second = createTasksChannel({ send: message => readOnly.receive(message), on: port.on.bind(port), off: port.off.bind(port) })
  await assert.rejects(second.request({ op: 'schedule_list' }, 'main'), /未启用/)
  channel.close(); second.close()
})

test('tasks are not started, stopped or messaged over this channel: only an accepted routing decision does that', () => {
  for (const op of ['start', 'stop', 'message']) assert.throws(() => parseTaskAction({ op, brief: '整理', taskId: 't1', text: '接着做' }))
})


test('task query IPC waits for async owner authorization before serializing data or failures', async () => {
  const port = new EventEmitter()
  const registry = createTaskRegistry()
  registry.put({ id: 'persisted', title: 'resume after restart', cwd: '/work' }, true)
  let release!: () => void
  const admitted = new Promise<void>(resolve => { release = resolve })
  let responses = 0
  const desk = createTasksDesk({
    send: message => { responses++; port.emit('message', message) }, authorized: () => true,
    read: async (request, session) => {
      await admitted
      if (session === 'revoked') throw new Error('owner rejected stale dependencies')
      return registry.query(request, { kind: 'main', cwd: '/work' })
    },
  })
  const channel = createTasksChannel({ send: message => desk.receive(message), on: port.on.bind(port), off: port.off.bind(port) })
  try {
    const pending = channel.request({ op: 'list' }, 'main')
    await Promise.resolve()
    assert.equal(responses, 0, 'an unresolved query must not become a successful empty object')
    release()
    const listed = JSON.parse(await pending) as { tasks: { taskId: string, status: string }[] }
    assert.equal(listed.tasks[0]!.taskId, 'persisted')
    assert.equal(listed.tasks[0]!.status, 'interrupted')
    const selected = JSON.parse(await channel.request({ op: 'get', taskId: 'persisted' }, 'main')) as { task: { taskId: string } }
    assert.equal(selected.task.taskId, 'persisted')
    await assert.rejects(channel.request({ op: 'list' }, 'revoked'), /owner rejected stale/)
  } finally { channel.close() }
})


test('a task query never publishes private results after its session expires during owner authorization', async () => {
  const port = new EventEmitter()
  let active = true, release!: () => void
  const paused = new Promise<void>(resolve => { release = resolve })
  const responses: object[] = []
  const desk = createTasksDesk({
    send: message => { responses.push(message); port.emit('message', message) }, authorized: () => active,
    read: async () => { await paused; return { observedAt: 0, tasks: [], total: 7, nextOffset: null } },
  })
  const channel = createTasksChannel({ send: message => desk.receive(message), on: port.on.bind(port), off: port.off.bind(port) })
  try {
    const pending = channel.request({ op: 'list' }, 'old-session')
    active = false; release()
    await assert.rejects(pending, /会话已失效/)
    assert.ok(responses.every(message => !JSON.stringify(message).includes('total')))
  } finally { channel.close() }
})
