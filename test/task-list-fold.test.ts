import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'

/** The 后台 page's list folds to a narrow strip and unfolds, by the user only. */

test('the list starts unfolded, folds and unfolds', () => {
  assert.equal(initialState.tasks.listFolded, false, 'not folded unless the user folds it')
  const folded = reduce(initialState, { type: 'tasks_list_folded', folded: true })
  assert.equal(folded.tasks.listFolded, true)
  assert.equal(reduce(folded, { type: 'tasks_list_folded', folded: false }).tasks.listFolded, false)
})

test('folded, it stays folded when the page closes and opens again', () => {
  const actions: Action[] = [
    { type: 'tasks_page_open' }, { type: 'tasks_list_folded', folded: true }, { type: 'tasks_page_close' }, { type: 'tasks_page_open' },
  ]
  const reopened = actions.reduce((state: State, action) => reduce(state, action), initialState)
  assert.deepEqual([reopened.tasks.page.open, reopened.tasks.listFolded], [true, true])
})
