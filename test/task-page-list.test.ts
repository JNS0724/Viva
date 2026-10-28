import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'

/** 后台's list is a second level of the hub's sidebar: unfolded when its page opens, folded and unfolded by 后台. */

test('the 后台 page opens with its list unfolded under 后台', () => {
  const open = reduce(initialState, { type: 'tasks_page_open' })
  assert.equal(open.tasks.page.list, true)
})

test('后台 clicked on its own page folds its list, and again unfolds it; the page stays open', () => {
  const open = reduce(initialState, { type: 'tasks_page_open' })
  const folded = reduce(open, { type: 'tasks_page_list' })
  assert.deepEqual([folded.tasks.page.open, folded.tasks.page.list], [true, false])
  const unfolded = reduce(folded, { type: 'tasks_page_list' })
  assert.equal(unfolded.tasks.page.list, true)
})

test('opened again, from another page or from a task\'s line, the list is unfolded whatever it was left as', () => {
  const actions: Action[] = [{ type: 'tasks_page_open' }, { type: 'tasks_page_list' }, { type: 'history_open' }]
  const folded = actions.reduce((state: State, action) => reduce(state, action), initialState)
  assert.equal(reduce(folded, { type: 'tasks_page_open' }).tasks.page.list, true)
})
