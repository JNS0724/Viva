import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { DOCK_SPACE, dockFolded, dockSummary, dockTasks, hasDockRoom } from '../src/renderer/tasks-state.ts'
import { cardedTasks } from '../src/renderer/view/task-card.ts'
import { clampColumn, COLUMN } from '../src/renderer/view/column-resize.ts'

const run = (actions, start = initialState) => actions.reduce((state, action) => reduce(state, action), start)
const started = (id, title, at) => ({ type: 'task_started', task: { id, title, words: title }, text: title, at })

/** Three tasks: one that ended (its report shown in the conversation), one at work, one waiting on a permission. */
function three() {
  return run([
    { type: 'history_loaded', conversationId: 'c1', messages: [{ role: 'assistant', text: '有什么可以帮你？' }], savedAt: 1 },
    started('done', '列一下这周要交的东西', 2),
    started('busy', '把全部文档整理成摘要', 3),
    started('asks', '整理本周销售数据', 4),
    { type: 'task_end', taskId: 'done', stopReason: 'end_turn', at: 5 },
    { type: 'task_report_shown', taskId: 'done' },
    { type: 'permission_request', requestId: 'p1', taskId: 'asks', toolCall: { toolCallId: 't1', title: '运行 Get-ChildItem' }, options: [], at: 6 },
  ])
}

test('the dock lists what waits on the user first, then what works, then what ended', () => {
  const state = three()
  assert.deepEqual(dockTasks(state).map(({ task }) => task.id), ['asks', 'busy', 'done'])
  assert.equal(dockTasks(state).find(({ task }) => task.id === 'done').report?.taskId, 'done', 'an ended task comes with what it came back with')
  assert.deepEqual(dockSummary(state), { live: 2, waiting: 1, ended: 1, failed: 0 })
  assert.deepEqual(dockTasks(initialState), [])
  assert.deepEqual(dockSummary(initialState), { live: 0, waiting: 0, ended: 0, failed: 0 })
})

test('a task that failed is counted on its own, not as done', () => {
  const state = run([
    { type: 'task_end', taskId: 'busy', stopReason: 'error', message: 'offline', at: 7 },
    { type: 'task_report_shown', taskId: 'busy' },
  ], three())
  assert.deepEqual(dockSummary(state), { live: 1, waiting: 1, ended: 2, failed: 1 })
})

test('put away from the dock, a task comes back when it ends again with something new', () => {
  const hidden = reduce(three(), { type: 'task_dock_hidden', taskId: 'done' })
  const askedAgain = run([
    { type: 'task_asked', taskId: 'done', text: '再补一条', at: 8 },
    { type: 'task_end', taskId: 'done', stopReason: 'end_turn', at: 9 },
  ], hidden)
  assert.equal(askedAgain.tasks.dockHidden.includes('done'), false)
  assert.ok(dockTasks(askedAgain).some(({ task }) => task.id === 'done'))
})

test('the dock unfolds with clear room and folds only when it is clearly gone, so a window at the edge does not flicker', () => {
  assert.equal(hasDockRoom(DOCK_SPACE.open, false), true)
  assert.equal(hasDockRoom(DOCK_SPACE.open - 1, false), false, 'not yet room enough to unfold')
  assert.equal(hasDockRoom(DOCK_SPACE.fold, true), true, 'between the two, it stays as it was')
  assert.equal(hasDockRoom(DOCK_SPACE.fold - 1, true), false)
  assert.ok(DOCK_SPACE.open > DOCK_SPACE.fold)
})

test('put away from the dock, an ended task stays in the conversation as its history', () => {
  const state = reduce(three(), { type: 'task_dock_hidden', taskId: 'done' })
  assert.deepEqual(dockTasks(state).map(({ task }) => task.id), ['asks', 'busy'])
  assert.ok(cardedTasks(state).some(({ task }) => task.id === 'done'), 'its card in the conversation is still there')
  // Put away from the conversation too, it has nothing more to show anywhere.
  const gone = reduce(three(), { type: 'task_report_dismissed', taskId: 'done' })
  assert.deepEqual(dockTasks(gone).map(({ task }) => task.id), ['asks', 'busy'])
})

test('a task at work or waiting cannot be put away from the dock, only an ended one', () => {
  const state = reduce(three(), { type: 'task_dock_hidden', taskId: 'busy' })
  assert.deepEqual(dockTasks(state).map(({ task }) => task.id), ['asks', 'busy', 'done'])
})

test('the dock folds and unfolds', () => {
  assert.equal(initialState.tasks.dockCollapsed, false)
  const folded = reduce(three(), { type: 'task_dock_toggled', collapsed: true })
  assert.equal(folded.tasks.dockCollapsed, true)
  assert.equal(reduce(folded, { type: 'task_dock_toggled', collapsed: false }).tasks.dockCollapsed, false)
})

test('without room beside the column the dock stays folded unless the user peeks; with room again, peeking ends', () => {
  const cramped = reduce(three(), { type: 'task_dock_room', room: false })
  assert.equal(dockFolded(cramped), true, 'no room: folded, whatever the user left it as')
  const peeking = reduce(cramped, { type: 'task_dock_peek', peek: true })
  assert.equal(dockFolded(peeking), false, 'a click on the tag shows it over the conversation')
  const roomy = reduce(peeking, { type: 'task_dock_room', room: true })
  assert.deepEqual([dockFolded(roomy), roomy.tasks.dockPeek], [false, false])
  assert.equal(reduce(cramped, { type: 'task_dock_room', room: false }), cramped, 'the same room again changes nothing')
  assert.equal(dockFolded(reduce(three(), { type: 'task_dock_toggled', collapsed: true })), true, 'folded by the user, folded with room too')
})

test('the conversation column is as wide as asked, within what the window allows', () => {
  assert.equal(COLUMN.default, 760)
  assert.equal(clampColumn(900, 1400), 900)
  assert.equal(clampColumn(300, 1400), COLUMN.min, 'never narrower than reads well')
  assert.equal(clampColumn(1600, 1200), 1200 - COLUMN.margin, 'never wider than the window leaves room for')
  assert.equal(clampColumn(Number.NaN, 1400), COLUMN.default, 'nothing usable saved: the default')
  assert.equal(clampColumn(800, 500), COLUMN.min, 'a window narrower than the minimum still gets the minimum (it scrolls)')
})
