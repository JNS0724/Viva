import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hubPage } from '../src/renderer/hub-state.js'
import { initialState, reduce } from '../src/renderer/state.js'
import { liveTasks, pageGroups, pageTask, taskMessages } from '../src/renderer/tasks-state.js'

/**
 * The 后台 page (view/tasks-page.js): every background task, grouped by where it stands, and the one picked
 * shown whole. It shares the space under the title bar with 搜索 · 关于你 · 设置 (hub-state.js).
 */

const run = (actions, start = initialState) => actions.reduce((state, action) => reduce(state, action), start)
const restored = (id, title, endedAt) => ({
  task: { id, segmentId: `c-${id}`, title, words: title }, status: 'done', endedAt,
  messages: [{ role: 'user', text: title, receipt: null }, { role: 'assistant', text: '好了。', receipt: null }],
})
const started = (id, text, at) => ({ type: 'task_started', task: { id, segmentId: `c-${id}`, title: text, words: text }, text, at })

test('a task started on its own leaves the words in the conversation, with the task under them, at work', () => {
  const state = run([started('s7', '把这周的提交整理成发布说明', 10)])

  const [words] = state.messages
  assert.deepEqual([words.role, words.text, words.taskId], ['user', '把这周的提交整理成发布说明', 's7'])
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
    { type: 'permission_request', requestId: 'p1', taskId: 's8', toolCall: { toolCallId: 't1', title: '访问 weather.example.com' }, options: [], at: 12 },
  ])

  assert.deepEqual(pageGroups(state).map(({ key, tasks }) => [key, tasks.map((t) => t.id)]),
    [['waiting', ['s8']], ['running', ['s7']], ['ended', ['new', 'old']]])
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

  const search = reduce(first, { type: 'history_open' })
  assert.deepEqual([hubPage(search), search.tasks.page.open], ['search', false])
  assert.equal(search.hub.last, 'search', 'the 关于你 icon never opens on the 后台 page')
  assert.equal(hubPage(reduce(first, { type: 'hub_close' })), null)
})

test('closing the task on show picks the next one; with none left the page says so', () => {
  const state = run([started('s7', '整理发布说明', 10), started('s8', '查天气', 11), { type: 'tasks_page_open', taskId: 's8' }])

  const next = reduce(state, { type: 'task_closed', taskId: 's8' })
  assert.equal(pageTask(next)?.id, 's7')
  assert.equal(pageTask(reduce(next, { type: 'task_closed', taskId: 's7' })), null)
})
