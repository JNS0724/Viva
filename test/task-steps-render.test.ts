import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { onlyTaskStepsChanged } from '../src/renderer/view/tasks-page.ts'

test('local process disclosure is isolated, but content and navigation changes invalidate reuse', () => {
  const opened = reduce(initialState, { type: 'tasks_page_open', taskId: null })
  const expanded = reduce(opened, { type: 'tasks_page_steps' })
  assert.equal(onlyTaskStepsChanged(opened, expanded), true)
  assert.equal(onlyTaskStepsChanged(expanded, opened), true)
  assert.equal(onlyTaskStepsChanged(opened, opened), false)
  assert.equal(onlyTaskStepsChanged(opened, { ...expanded, tasks: { ...expanded.tasks, list: [...expanded.tasks.list] } }), false)
  assert.equal(onlyTaskStepsChanged(opened, { ...expanded, feed: { ...expanded.feed } }), false)
  assert.equal(onlyTaskStepsChanged(opened, { ...expanded, tasks: { ...expanded.tasks, page: { ...expanded.tasks.page, selected: 'other' } } }), false)
  assert.equal(onlyTaskStepsChanged(opened, reduce(expanded, { type: 'tasks_page_close' })), false)
})

test('the earlier steps, asked for, are a disclosure too; another task or folding again shows the latest only', () => {
  const expanded = reduce(reduce(initialState, { type: 'tasks_page_open', taskId: null }), { type: 'tasks_page_steps' })
  const all = reduce(expanded, { type: 'tasks_page_all_steps' })
  assert.deepEqual([expanded.tasks.page.allSteps, all.tasks.page.allSteps], [false, true])
  assert.equal(onlyTaskStepsChanged(expanded, all), true)
  assert.equal(reduce(all, { type: 'tasks_page_select', taskId: 'other' }).tasks.page.allSteps, false)
  assert.equal(reduce(all, { type: 'tasks_page_steps' }).tasks.page.allSteps, false)
  assert.equal(reduce(all, { type: 'tasks_page_open', taskId: null }).tasks.page.allSteps, false)
})
