import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hubPage } from '../src/renderer/hub-state.ts'
import { initialState, reduce } from './fixtures/task-window.ts'
import { liveTasks, pageGroups, pageTask, taskMessages } from '../src/renderer/tasks-state.ts'

/**
 * The 后台 page (view/tasks-page.ts): every background task, grouped by where it stands, and the one picked shown whole.
 * It shares the space under the title bar with 搜索 · 定时任务 · 关于你 · 设置 (hub-state.ts).
 */

type WindowState = Parameters<typeof reduce>[0]
type TestAction = Parameters<typeof reduce>[1]

const run = (actions: readonly TestAction[], start: WindowState = initialState as WindowState): WindowState =>
  actions.reduce((state, action) => reduce(state, action), start)

const restored = (id: string, title: string, endedAt: number) => ({
  task: { id, segmentId: `c-${id}`, title, words: title }, status: 'done' as const, endedAt,
  messages: [{ role: 'user', text: title, receipt: null }, { role: 'assistant', text: '好了。', receipt: null }],
})
const started = (id: string, text: string, at: number): TestAction => ({
  type: 'task_started', task: { id, segmentId: `c-${id}`, title: text, words: text }, text, at,
})

test('a task started on its own leaves only its card in the conversation and keeps the request in task details', () => {
  const state = run([started('s7', '把这周的提交整理成发布说明', 10)])

  assert.deepEqual(state.messages, [], 'a background request does not create a foreground user bubble')
  assert.deepEqual(state.taskCards, ['s7'], 'the card is anchored even without a foreground message')
  assert.equal(state.phase, 'idle', 'the conversation on screen is not busy for it')
  const [task] = liveTasks(state)
  assert.deepEqual([task.id, task.status, task.startedAt], ['s7', 'running', 10])
  assert.deepEqual(taskMessages(task).map((m) => m.text), ['把这周的提交整理成发布说明'])
})

test('the page groups the tasks: waiting on the user, then at work, then ended, latest first', () => {
  const state = run([
    { type: 'tasks_restored', list: [restored('old', '整理 Q3 的发票', 5), restored('new', '把周报发给张三', 9)] },
    started('s7', '把这周的提交整理成发布说明', 10),
    started('s8', '查一下明天上海的天气', 11),
    { type: 'permission_request', requestId: 'p1', taskId: 's8', toolCall: { toolCallId: 't1', title: '访问 weather.example.com' }, options: [], at: 12 } as unknown as TestAction,
  ])

  assert.deepEqual(pageGroups(state).map(({ key, tasks }) => [key, tasks.map((t) => t.id)]),
    [['waiting', ['s8']], ['running', ['s7']], ['ended', ['new', 'old']]])
})

test('interrupted tasks appear in their own group right after waiting and never inside ended or liveTasks', () => {
  const interrupted = (id: string, title: string, endedAt: number) => ({
    task: { id, segmentId: `c-${id}`, title, words: title }, status: 'interrupted' as const, endedAt,
    messages: [{ role: 'user', text: title, receipt: null }],
  })
  const state = run([
    { type: 'tasks_restored', list: [restored('done-1', '已完成的任务', 8), interrupted('int-1', '断开的任务', 6)] },
    started('run-1', '运行中的任务', 10),
    started('wait-1', '等待中的任务', 11),
    { type: 'permission_request', requestId: 'p1', taskId: 'wait-1', toolCall: { toolCallId: 't1', title: '确认' }, options: [], at: 12 } as unknown as TestAction,
  ])

  assert.deepEqual(pageGroups(state).map(({ key, tasks }) => [key, tasks.map((t) => t.id)]),
    [['waiting', ['wait-1']], ['interrupted', ['int-1']], ['running', ['run-1']], ['ended', ['done-1']]])
  assert.deepEqual(liveTasks(state).map((t) => t.id), ['run-1', 'wait-1'])
})

test('opened, the page shows the task asked for, or the first in it; it closes the other pages and they close it', () => {
  const state = run([
    { type: 'tasks_restored', list: [restored('old', '整理 Q3 的发票', 5)] },
    started('s7', '把这周的提交整理成发布说明', 10),
    { type: 'settings_open' },
  ])

  const first = reduce(state, { type: 'tasks_page_open' })
  assert.deepEqual([hubPage(first), pageTask(first)?.id, first.settings.open], ['tasks', 's7', false])
  assert.equal(pageTask(reduce(first, { type: 'tasks_page_open', taskId: 'old' }))?.id, 'old')
  assert.equal(pageTask(reduce(first, { type: 'tasks_page_select', taskId: 'old' }))?.id, 'old')

  assert.equal(first.hub.last, 'tasks', '后台 is one of the hub\'s pages: the 关于你 icon opens on it when it was the last shown')
  const search = reduce(first, { type: 'history_open' })
  assert.deepEqual([hubPage(search), search.tasks.page.open], ['search', false])
  assert.equal(search.hub.last, 'search')
  assert.equal(hubPage(reduce(first, { type: 'hub_close' })), null)
})

test('closing the task on show picks the next one; with none left the page says so', () => {
  const state = run([started('s7', '整理发布说明', 10), started('s8', '查天气', 11), { type: 'tasks_page_open', taskId: 's8' }])

  const next = reduce(state, { type: 'task_closed', taskId: 's8' })
  assert.equal(pageTask(next)?.id, 's7')
  assert.equal(pageTask(reduce(next, { type: 'task_closed', taskId: 's7' })), null)
})
