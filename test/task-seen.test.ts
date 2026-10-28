import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { dockTasks, unseenEnded } from '../src/renderer/tasks-state.ts'
import { islandView } from '../src/renderer/island-view.ts'

/** An ended task, once seen on the 后台 page, is no longer reminded of: not in the dock, not at the island's tail. */

const run = (actions: Action[], start: State = initialState): State => actions.reduce((state, action) => reduce(state, action), start)
const started = (id: string, title: string, at: number): Action => ({ type: 'task_started', task: { id, title, words: title }, text: title, at })

/** Two tasks ended (one done, one failed), one at work. */
function twoEnded(): State {
  return run([
    { type: 'history_loaded', conversationId: 'c1', messages: [{ role: 'assistant', text: '有什么可以帮你？' }], savedAt: 1 },
    started('a', '列一下这周要交的东西', 2),
    started('b', '核对这个月的发票', 3),
    started('c', '整理周会纪要', 4),
    { type: 'task_end', taskId: 'a', stopReason: 'end_turn', at: 5 },
    { type: 'task_end', taskId: 'b', stopReason: 'error', message: 'offline', at: 6 },
    { type: 'task_report_shown', taskId: 'a' },
    { type: 'task_report_shown', taskId: 'b' },
  ])
}
const ids = (tasks: ReadonlyArray<{ id: string }>) => tasks.map((task) => task.id)

test('ended tasks are reminded of until seen; one at work never counts as ended', () => {
  const state = twoEnded()
  assert.deepEqual(ids(unseenEnded(state)), ['a', 'b'])
  assert.equal(islandView(state).background?.done, 2)
  assert.equal(islandView(state).background?.count, 1, 'the one at work')
})

test('opened on the 后台 page, an ended task is seen: out of the dock, not counted, the island no longer says it ended', () => {
  const seen = reduce(twoEnded(), { type: 'tasks_page_open', taskId: 'b' })
  assert.deepEqual(ids(unseenEnded(seen)), ['a'])
  assert.equal(islandView(seen).background?.done, 1)
  assert.equal(dockTasks(seen).some(({ task }) => task.id === 'b'), false)
  assert.equal(seen.tasks.finished, null, 'the island had been saying the last one (b) ended')
  const both = reduce(seen, { type: 'tasks_page_select', taskId: 'a' })
  assert.deepEqual(ids(unseenEnded(both)), [])
})

test('a task at work opened on its page is not marked seen: it still has to end', () => {
  const opened = reduce(twoEnded(), { type: 'tasks_page_open', taskId: 'c' })
  assert.equal(opened.tasks.dockHidden.includes('c'), false)
  const ended = reduce(opened, { type: 'task_end', taskId: 'c', stopReason: 'end_turn', at: 9 })
  assert.equal(ids(unseenEnded(ended)).includes('c'), true)
})

test('something new from a seen task reminds again', () => {
  const seen = reduce(twoEnded(), { type: 'tasks_page_open', taskId: 'a' })
  const again = run([
    { type: 'task_asked', taskId: 'a', text: '再补一条', at: 10 },
    { type: 'task_end', taskId: 'a', stopReason: 'end_turn', at: 11 },
  ], seen)
  assert.equal(ids(unseenEnded(again)).includes('a'), true)
})

test('seen by the last launch, a task is not reminded of again; what was kept that is not an id is ignored', () => {
  const restored = reduce(twoEnded(), { type: 'tasks_seen_restored', ids: ['a', 7, null] })
  assert.deepEqual(ids(unseenEnded(restored)), ['b'])
  assert.deepEqual(reduce(restored, { type: 'tasks_seen_restored', ids: 'not a list' }).tasks.dockHidden, ['a'])
})
