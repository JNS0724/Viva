import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from './fixtures/task-window.ts'
import { isRecentUnread, RECENT_UNREAD_MS, shownOnPage, unseenEnded } from '../src/renderer/tasks-state.ts'
import { islandView } from '../src/renderer/island-view.ts'
import { noteFor } from '../src/backend/task-reports.ts'

/** An ended task, once seen on the 后台 page, is no longer reminded of at the island's tail. */

type FixtureAction = Parameters<typeof reduce>[1]
const run = (actions: FixtureAction[], start: State = initialState): State => actions.reduce((state, action) => reduce(state, action), start)
const started = (id: string, title: string, at: number): FixtureAction => ({ type: 'task_started', task: { id, title, words: title }, text: title, at })

/** Two tasks ended (one done, one failed), one at work. */
function twoEnded(): State {
  return run([
    { type: 'history_loaded', conversationId: 'c1', messages: [{ role: 'assistant', text: '有什么可以帮你？' }], savedAt: 1 },
    started('a', '列一下这周要交的东西', 2),
    started('b', '核对这个月的发票', 3),
    started('c', '整理周会纪要', 4),
    { type: 'task_end', taskId: 'a', stopReason: 'end_turn', at: 5 },
    { type: 'task_end', taskId: 'b', stopReason: 'error', message: 'offline', at: 6 },
  ])
}
const ids = (tasks: ReadonlyArray<{ id: string }>) => tasks.map((task) => task.id)

test('ended tasks are unread until seen; the island shows only the one at work', () => {
  const state = twoEnded()
  assert.deepEqual(ids(unseenEnded(state)), ['a', 'b'])
  assert.equal(islandView(state).background?.count, 1, 'the one at work')
  assert.deepEqual(islandView(state).background?.items.map((item) => item.id), ['c'], 'ended ones are the conversation\'s to tell')
})

test('opened on the 后台 page, an ended task is seen: no longer counted', () => {
  const seen = reduce(twoEnded(), { type: 'tasks_page_open', taskId: 'b' })
  assert.deepEqual(ids(unseenEnded(seen)), ['a'])
  const both = reduce(seen, { type: 'tasks_page_select', taskId: 'a' })
  assert.deepEqual(ids(unseenEnded(both)), [])
})

test('a task at work opened on its page is not marked seen: it still has to end', () => {
  const opened = reduce(twoEnded(), { type: 'tasks_page_open', taskId: 'c' })
  assert.equal(opened.tasks.seen.includes('c'), false)
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

/** All three ended: none at work, so whichever the page goes on to is an ended one. */
const threeEnded = () => reduce(twoEnded(), { type: 'task_end', taskId: 'c', stopReason: 'end_turn', at: 7 })

test('关掉这件 on the page: the next task it goes on to is shown, so seen', () => {
  const closed = run([{ type: 'tasks_page_open', taskId: 'b' }, { type: 'task_closed', taskId: 'b' }], threeEnded())
  const next = closed.tasks.page.selected
  assert.ok(next && ['a', 'c'].includes(next))
  assert.deepEqual(ids(unseenEnded(closed)), ['a', 'c'].filter((id) => id !== next), 'only the one not shown is still reminded of')
})

test('the page left, what it showed is seen, also when it picked it by itself', () => {
  // Picked a task since gone (undone, say): the page shows the first listed, and leaving it, that one is seen.
  const opened = reduce(threeEnded(), { type: 'tasks_page_open', taskId: 'a' })
  const shownByItself = { ...opened, tasks: { ...opened.tasks, page: { ...opened.tasks.page, selected: 'gone' } } }
  const shown = shownOnPage(shownByItself)
  assert.ok(shown && shown !== 'gone', 'the page shows the first listed')
  const left = reduce(shownByItself, { type: 'tasks_page_close' })
  assert.equal(left.tasks.page.open, false)
  assert.deepEqual(ids(unseenEnded(left)).toSorted(), ['b', 'c'].filter((id) => id !== shown), 'a (opened) and the one shown by itself are seen')
})

test('seen by the last launch, a task is not reminded of again; what was kept that is not an id is ignored', () => {
  // @ts-expect-error Invalid persisted ids are ignored defensively.
  const restored = reduce(twoEnded(), { type: 'tasks_seen_restored', ids: ['a', 7, null] })
  assert.deepEqual(ids(unseenEnded(restored)), ['b'])
  // @ts-expect-error Invalid persisted collection is ignored defensively.
  assert.deepEqual(reduce(restored, { type: 'tasks_seen_restored', ids: 'not a list' }).tasks.seen, ['a'])
})

/** The record of a task run's result, as the backend keeps it (report-records.ts): one per run, keyed task:run. */
const note = (taskId: string, title: string) => noteFor([{ taskId, title, status: 'done', host: null, output: '做完了' }])
const delivered = (taskId: string, title: string, { conversationId = 'c1', run = 'run-1' } = {}): FixtureAction =>
  ({ type: 'report_delivered', conversationId, sessionId: null, reportId: `${taskId}:${run}`, text: note(taskId, title), at: 8 })

test('a result come into the conversation on screen tells its task: no longer unread', () => {
  const told = run([delivered('a', '列一下这周要交的东西'), delivered('b', '核对这个月的发票')], twoEnded())

  assert.equal(told.records.length, 2, 'drawn in the conversation')
  assert.deepEqual(ids(unseenEnded(told)), [])
})

test('a result for a conversation not on screen tells nothing: its task is still unread', () => {
  const elsewhere = reduce(twoEnded(), delivered('a', '列一下这周要交的东西', { conversationId: 'c-other' }))

  assert.deepEqual(ids(unseenEnded(elsewhere)), ['a', 'b'])
})

test('a conversation opened with a result in it tells that task, as its result is drawn there now', () => {
  const record = { reportId: 'a:run-1', at: 8, text: note('a', '列一下这周要交的东西'), after: 1 }
  // Another conversation opened: the window starts it empty (a switch), then loads what was kept of it.
  const switched = { ...twoEnded(), conversationId: null, messages: [], records: [] }
  const opened = reduce(switched, { type: 'history_loaded', conversationId: 'c2', messages: [{ role: 'assistant', text: '好的' }], records: [record], savedAt: 9 })

  assert.deepEqual(ids(unseenEnded(opened)), ['b'])
})

test('a task told of, asked again and ended again, is unread again: the record of its earlier run tells nothing', () => {
  const told = reduce(twoEnded(), delivered('a', '列一下这周要交的东西'))
  const again = run([
    { type: 'task_asked', taskId: 'a', text: '再补一条', at: 10 },
    { type: 'task_end', taskId: 'a', stopReason: 'end_turn', at: 11 },
  ], told)

  assert.equal(again.records.some((record) => record.reportId === 'a:run-1'), true, 'the earlier record is still drawn')
  assert.equal(ids(unseenEnded(again)).includes('a'), true)
  const newRun = again.tasks.list.find((task) => task.id === 'a')!.runId
  assert.equal(ids(unseenEnded(reduce(again, delivered('a', '列一下这周要交的东西', { run: newRun })))).includes('a'), false, 'its new result tells it')
})

test('the 后台 page marks only the recent unread: one ended long ago is just listed', () => {
  const state = twoEnded()
  const task = (id: string) => state.tasks.list.find((entry) => entry.id === id)!
  const endedAt = task('a').endedAt!

  assert.equal(isRecentUnread(state, task('a'), endedAt + RECENT_UNREAD_MS), true, 'within the window')
  assert.equal(isRecentUnread(state, task('a'), endedAt + RECENT_UNREAD_MS + 1), false, 'past it')
  assert.equal(isRecentUnread(state, task('c'), endedAt), false, 'one at work is never unread')
  const seen = reduce(state, { type: 'tasks_page_open', taskId: 'a' })
  assert.equal(isRecentUnread(seen, task('a'), endedAt), false, 'opened: read')
})

test('a result come in while a page covers the conversation is unread until the conversation is back in view', () => {
  const covered = run([{ type: 'tasks_page_open', taskId: 'c' }, delivered('a', '列一下这周要交的东西')], twoEnded())
  assert.equal(ids(unseenEnded(covered)).includes('a'), true, 'drawn there, not seen')

  const back = reduce(covered, { type: 'tasks_page_close' })
  assert.equal(ids(unseenEnded(back)).includes('a'), false, 'back in view: told')
})
