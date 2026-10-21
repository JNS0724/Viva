import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.js'
import { answerPreview, islandView } from '../src/renderer/island-view.js'

const T0 = new Date(2026, 9, 20, 10, 0, 0).getTime()
const live = { type: 'ready', info: { mode: 'live', model: 'deepseek-v4-flash', cwd: '/w', reason: '' } }
const run = (actions) => actions.reduce(reduce, initialState)
const asked = [live, { type: 'user_prompt', text: '明天上海天气', at: T0 }]
const tool = (id, title, status) => ({ type: 'acp_update', at: T0 + 1000, update: { sessionUpdate: 'tool_call', toolCallId: id, title, status } })
const permission = {
  type: 'permission_request', requestId: 'p1', at: T0 + 2000,
  toolCall: { title: '写入 summary.md', kind: 'edit' },
  options: [{ optionId: 'ok', name: '允许', kind: 'allow_once' }, { optionId: 'no', name: '拒绝', kind: 'reject_once' }],
}
const question = (items) => ({ type: 'question_request', questionId: 'q1', questions: items, at: T0 + 2000 })
const city = { id: 'city', question: '你想看哪个城市的天气？', header: '城市', multiSelect: false, options: [{ label: '上海' }, { label: '北京' }] }

test('before the agent is connected the island says so, with no panel content', () => {
  assert.deepEqual(islandView(initialState), { form: 'pending', tone: 'pending', mood: 'idle', label: '连接中', recent: [] })
  const setup = run([{ type: 'ready', info: { mode: 'setup', problem: 'no-key', cwd: '/w', model: '' } }])
  assert.equal(islandView(setup).label, '未连接')
})

test('idle shows the model; working shows what runs now, since when, how many steps and the latest steps', () => {
  assert.deepEqual(islandView(run([live])), { form: 'idle', tone: 'idle', mood: 'idle', label: '空闲', detail: 'deepseek-v4-flash', recent: [] })

  const working = islandView(run([...asked, tool('a', '搜索「上海 天气」', 'completed'), tool('b', '读取网页 weather.com.cn', 'in_progress')]))
  assert.equal(working.form, 'working')
  assert.equal(working.mood, 'typing')
  assert.equal(working.action, '读取网页 weather.com.cn')
  assert.equal(working.startedAt, T0)
  assert.equal(working.steps, 2)
  assert.deepEqual(working.recent.map((row) => [row.title, row.tone]), [['搜索「上海 天气」', 'done'], ['读取网页 weather.com.cn', 'working']])
})

test('only the last few steps come along', () => {
  const many = Array.from({ length: 7 }, (_, i) => tool(`t${i}`, `第 ${i} 步`, 'completed'))
  const view = islandView(run([...asked, ...many]))
  assert.deepEqual(view.recent.map((row) => row.title), ['第 3 步', '第 4 步', '第 5 步', '第 6 步'])
})

test('a permission carries its options with their roles, under the same head as in the window', () => {
  const view = islandView(run([...asked, permission]))
  assert.equal(view.form, 'waiting')
  assert.equal(view.tone, 'waiting')
  assert.equal(view.label, '需要你确认')
  assert.deepEqual(view.permission, {
    requestId: 'p1', title: '写入 summary.md', command: '',
    options: [{ optionId: 'ok', name: '允许', role: 'primary' }, { optionId: 'no', name: '拒绝', role: 'secondary' }],
  })
})

test('a command to approve shows on the island too, not just its title', () => {
  const bash = [...asked,
    { type: 'acp_update', at: T0 + 1000, update: { sessionUpdate: 'tool_call', toolCallId: 'b1', title: 'bash', status: 'pending', rawInput: { command: 'rm -rf build' } } },
    { ...permission, toolCall: { toolCallId: 'b1' } }]
  const view = islandView(run(bash))
  assert.deepEqual([view.permission.title, view.permission.command], ['运行命令', 'rm -rf build'])
})

test('a single single-choice question can be answered by its options; anything else needs the window', () => {
  const single = islandView(run([...asked, question([city])]))
  assert.equal(single.form, 'asking')
  assert.equal(single.label, '需要你回答')
  assert.deepEqual(single.question, {
    questionId: 'q1', id: 'city', header: '城市', text: '你想看哪个城市的天气？', options: ['上海', '北京'], skippable: true,
  })

  const two = islandView(run([...asked, question([city, { ...city, id: 'day', question: '哪天？' }])]))
  assert.deepEqual(two.question.options, [], 'two questions are answered in the window')
  const multi = islandView(run([...asked, question([{ ...city, multiSelect: true }])]))
  assert.deepEqual(multi.question.options, [])
})

test('done keeps how long it took and the start of the answer; stopped and failed say so', () => {
  const answered = [...asked,
    { type: 'acp_update', at: T0, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '## 天气\n**上海**明天多云，18–24°C。' } } },
    { type: 'turn_end', stopReason: 'end_turn', at: T0 + 21_000 }]
  const done = islandView(run(answered))
  assert.equal(done.form, 'done')
  assert.equal(done.tone, 'done')
  assert.equal(done.elapsedMs, 21_000)
  assert.equal(done.detail, '天气')

  const stopped = islandView(run([...asked, { type: 'turn_end', stopReason: 'cancelled', at: T0 + 1000 }]))
  assert.equal(stopped.form, 'idle')
  assert.equal(stopped.label, '已停止')

  const failed = islandView(run([...asked, { type: 'error', message: 'dsh 已退出' }]))
  assert.deepEqual([failed.form, failed.tone, failed.mood, failed.detail], ['error', 'error', 'error', 'dsh 已退出'])
})

test('the answer preview is its first line of text, without Markdown marks, kept short', () => {
  assert.equal(answerPreview('\n\n> **上海**明天 `多云`'), '上海明天 多云')
  assert.equal(answerPreview('- [x] 已保存'), '已保存')
  assert.equal(answerPreview('一'.repeat(80)).length, 40)
  assert.equal(answerPreview(''), '')
})

/** 「明天上海天气」 moved to the background while it ran; the conversation went on with 「周会几点」. */
const spun = [...asked, tool('a', '运行 git log', 'in_progress'), {
  type: 'task_spun', at: T0 + 3000, text: '周会几点',
  task: { id: 's1', segmentId: 'c1', title: '明天上海天气', words: '明天上海天气' },
  conversation: { id: 'c2', messages: [] }, info: { sessionId: 's2' }, folds: [],
}]
const taskAsks = { ...permission, taskId: 's1', requestId: 'p9', at: T0 + 4000 }

test('tasks in the background: a count at the tail, and one line each when the island opens', () => {
  const view = islandView(run(spun))
  assert.equal(view.form, 'idle', 'the island still says what the conversation on screen does')
  assert.deepEqual(view.background, {
    count: 1, waiting: 0,
    items: [{ id: 's1', title: '明天上海天气', status: 'running', now: '运行 git log', startedAt: T0 }],
  })
  assert.equal(islandView(run([live])).background, undefined, 'with none, nothing changes')
})

test('a task waiting on the user takes the whole island, named, and is first in the list', () => {
  const view = islandView(run([...spun, taskAsks]))
  assert.deepEqual([view.form, view.tone, view.label, view.task], ['waiting', 'waiting', '需要你确认', '明天上海天气'])
  assert.equal(view.permission.requestId, 'p9')
  assert.deepEqual([view.background.waiting, view.background.items[0].permission.requestId], [1, 'p9'])

  const mainAsks = islandView(run([...spun, taskAsks, { type: 'user_prompt', text: '周会几点', at: T0 + 5000 }, permission]))
  assert.deepEqual([mainAsks.permission.requestId, mainAsks.task], ['p1', undefined], 'the conversation on screen comes first')
})

test('a task that ends says so for a moment, while the conversation is quiet', () => {
  const ended = run([...spun, { type: 'task_end', taskId: 's1', stopReason: 'end_turn', at: T0 + 9000 }])
  const view = islandView(ended)
  assert.deepEqual([view.form, view.tone, view.label], ['done', 'done', '#明天上海天气 做完了'])
  assert.deepEqual(view.background.count, 0)
  assert.equal(islandView(reduce(ended, { type: 'task_finish_seen', taskId: 's1' })).label, '空闲')
  const failed = islandView(run([...spun, { type: 'task_end', taskId: 's1', stopReason: 'error', at: T0 + 9000 }]))
  assert.deepEqual([failed.label, failed.tone], ['#明天上海天气 出错了', 'error'])
})

test('the view is plain data, so it can travel to the desktop island', () => {
  const view = islandView(run([...asked, permission]))
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view)
})
