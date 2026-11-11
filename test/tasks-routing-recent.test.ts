import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_RECENT_TASKS, RECENT_REQUESTS, recentNote, recentTasks } from '../plugins/routing/lib/recent-tasks.ts'
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

  assert.equal(recentTasks(after(RECENT_REQUESTS))[0]?.ago, RECENT_REQUESTS)
  assert.deepEqual(recentTasks(after(RECENT_REQUESTS + 1)), [])
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
