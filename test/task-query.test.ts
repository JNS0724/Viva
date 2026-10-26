import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createTaskRegistry, parseTaskQuery } from '../src/main/task-registry.ts'
import { createTasksDesk } from '../src/main/tasks-channel.ts'
import { createTasksChannel } from '../plugins/tasks/lib/channel.ts'
import { initialState, reduce } from '../src/renderer/state.ts'

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

test('pending question and completion arriving during spin-off are replayed when metadata arrives', () => {
  const registry = createTaskRegistry()
  registry.receive({ type: 'task_question', taskId: 'a', questionId: 'q' })
  registry.put({ id: 'a', title: 'task' })
  assert.equal(registry.query({ op: 'get', taskId: 'a' }, { taskId: 'a' }).task!.status, 'waiting')
  registry.receive({ type: 'task_end', taskId: 'b', stopReason: 'cancelled' })
  registry.put({ id: 'b', title: 'task' })
  assert.equal(registry.query({ op: 'get', taskId: 'b' }, { taskId: 'b' }).task!.status, 'stopped')
})

test('queries restrict workspace and background callers, paginate, and omit request/output by default', () => {
  const registry = createTaskRegistry()
  for (const [id, cwd] of [['a', '/one'], ['b', '/one'], ['c', '/two']]) registry.put({ id: id!, cwd, title: id!, words: 'private' })
  const list = registry.query({ op: 'list', limit: 1 }, { cwd: '/one' })
  assert.equal(list.total, 2); assert.equal(list.tasks!.length, 1); assert.equal(list.nextOffset, 1)
  assert.equal(JSON.stringify(list).includes('private'), false)
  assert.equal(registry.query({ op: 'list' }, { taskId: 'a' }).total, 1)
  assert.throws(() => registry.query({ op: 'get', taskId: 'c' }, { cwd: '/one' }), /不存在/)
  assert.throws(() => registry.query({ op: 'get', taskId: 'b' }, { taskId: 'a' }), /不存在/)
  registry.remove('a'); assert.equal(registry.query({ op: 'list' }, { taskId: 'a' }).total, 0)
  assert.equal(parseTaskQuery({ op: 'list', limit: 100 }).limit, 30)
  for (const request of [{ op: 'stop' }, { op: 'get' }, { op: 'list', offset: -1 }, { op: 'list', includeOutput: 'yes' }, { op: 'list', status: 'fake' }]) assert.throws(() => parseTaskQuery(request))
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
  const interrupted = reduce(started, { type: 'task_snapshot', snapshot })
  assert.equal(interrupted.tasks.list[0]!.status, 'interrupted')
  assert.equal(interrupted.tasks.list[0]!.now, null)
})
