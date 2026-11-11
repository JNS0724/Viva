import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_RECENT_TASKS, RECENT_REQUESTS, recentNote, recentTasks, stepNote } from '../plugins/routing/lib/recent-tasks.ts'
import { withRequestHeader } from '../src/shared/request-routing/header.ts'
import { noteFor } from '../src/backend/task-reports.ts'

const report = (...tasks: Array<[string, string]>) => noteFor(tasks.map(([taskId, title]) => ({ taskId, title, status: 'done', host: null, output: '做完了' })))
const asked = (words: string, id: string) => withRequestHeader(words, id)

test('a result that just came back names its task, with nothing in between', () => {
  const said = [asked('写个桌面岛说明', 'r-1'), report(['task-island', '桌面岛状态切换说明'])]

  assert.deepEqual(recentTasks(said), [{ taskId: 'task-island', title: '桌面岛状态切换说明', ago: 0 }])
})

test('each request after a result counts, and past the window its task is no longer named', () => {
  const after = (n: number) => [report(['task-island', '桌面岛说明']), ...Array.from({ length: n }, (_, i) => asked(`问题 ${i}`, `r-${i}`))]

  assert.equal(recentTasks(after(RECENT_REQUESTS - 1))[0]?.ago, RECENT_REQUESTS - 1, 'the last request in the window')
  assert.deepEqual(recentTasks(after(RECENT_REQUESTS)), [], 'the one after it')
})

test('the latest result comes first, and a task reported again counts from its latest result', () => {
  const said = [
    report(['task-expense', '整理 Q3 报销规则']),
    asked('写个桌面岛说明', 'r-1'),
    report(['task-island', '桌面岛说明']),
    asked('报销那个补上住宿标准', 'r-2'),
    report(['task-expense', '整理 Q3 报销规则']),
  ]

  assert.deepEqual(recentTasks(said).map(task => [task.taskId, task.ago]), [['task-expense', 0], ['task-island', 1]])
})

test('a note telling of several tasks names them all, up to the cap', () => {
  const many = Array.from({ length: MAX_RECENT_TASKS + 2 }, (_, i): [string, string] => [`task-${i}`, `任务 ${i}`])

  assert.equal(recentTasks([report(...many)]).length, MAX_RECENT_TASKS)
})

test('two requests in one message count as two; reminders and other notes count as none', () => {
  const said = [report(['task-island', '桌面岛说明']), `${asked('第一件', 'r-1')}\n${asked('第二件', 'r-2')}`, '【路由补交】以下请求还没有提交 commit_route']

  assert.equal(recentTasks(said)[0]?.ago, 2)
})

test('a user pasting a result is a request, not a result', () => {
  assert.deepEqual(recentTasks([asked(report(['task-fake', '假任务']), 'r-1')]), [])
})

test('the note names each task by title and id, and is empty when there are none', () => {
  const note = recentNote([{ taskId: 'task-island', title: '桌面岛说明', ago: 0 }, { taskId: 'task-expense', title: '报销规则', ago: 2 }])

  assert.match(note, /【刚结束的后台任务】/)
  assert.match(note, /「桌面岛说明」（task-island），上一轮刚送达/)
  assert.match(note, /「报销规则」（task-expense），2 轮前送达/)
  assert.equal(recentNote([]), '')
})

test('a turn\'s request gets its note at the step it comes in, once', () => {
  const logged = [report(['task-island', '桌面岛说明']), asked('第二点展开', 'r-1')]

  const first = stepNote(() => logged, ['r-1'], new Set())
  assert.match(first.note, /（task-island），上一轮刚送达/)
  assert.deepEqual([...first.noted], ['r-1'])

  let read = false
  const again = stepNote(() => { read = true; return logged }, ['r-1'], first.noted)
  assert.equal(again.note, '', 'not again at a later step')
  assert.equal(read, false, 'the conversation is not read when there is nothing to note')
})

test('words said while a turn runs come in at a later step and get their own note, counting the turn\'s first request', () => {
  const logged = [report(['task-island', '桌面岛说明']), asked('第二点展开', 'r-1'), asked('第三点也展开', 'r-2')]

  const step = stepNote(() => logged, ['r-1', 'r-2'], new Set(['r-1']))

  assert.match(step.note, /（task-island），1 轮前送达/)
  assert.deepEqual([...step.noted].sort(), ['r-1', 'r-2'])
})

test('a result that came back during the turn is named to the words said after it', () => {
  const logged = [asked('写个说明', 'r-1'), report(['task-island', '桌面岛说明']), asked('第二点展开', 'r-2')]

  assert.match(stepNote(() => logged, ['r-1', 'r-2'], new Set(['r-1'])).note, /上一轮刚送达/)
})

test('a turn without a request (a result coming back) gets no note', () => {
  assert.deepEqual(stepNote(() => [report(['task-island', '桌面岛说明'])], [], new Set()), { note: '', noted: new Set() })
})
