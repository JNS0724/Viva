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
  assert.equal(onlyTaskStepsChanged(opened, { ...expanded, followups: { ...expanded.followups } }), false)
  assert.equal(onlyTaskStepsChanged(opened, { ...expanded, tasks: { ...expanded.tasks, page: { ...expanded.tasks.page, selected: 'other' } } }), false)
  assert.equal(onlyTaskStepsChanged(opened, reduce(expanded, { type: 'tasks_page_close' })), false)
})
