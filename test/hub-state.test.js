import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hubPage } from '../src/renderer/hub-state.js'
import { initialState, reduce } from '../src/renderer/state.js'

/**
 * 搜索, 关于你 and 设置 share one page over the conversation (view/hub.js): one of them at a time,
 * and the next time it opens, it opens on the one last shown.
 */

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    Object.values(value).forEach(deepFreeze)
  }
  return value
}

const run = (actions, start = initialState) => actions.reduce((state, action) => reduce(deepFreeze(state), action), start)

test('nothing is open at first, and the page opens on 关于你', () => {
  assert.equal(hubPage(initialState), null)
  assert.equal(initialState.hub.last, 'profile')
})

test('opening one page closes the one that was open and is remembered', () => {
  const settings = run([{ type: 'settings_open' }])
  const search = run([{ type: 'history_open' }], settings)
  const profile = run([{ type: 'memory_open' }], search)

  assert.deepEqual([hubPage(settings), settings.hub.last], ['settings', 'settings'])
  assert.deepEqual([search.settings.open, search.history.open, hubPage(search), search.hub.last], [false, true, 'search', 'search'])
  assert.deepEqual([profile.history.open, hubPage(profile), profile.hub.last], [false, 'profile', 'profile'])
})

test('closing the page closes whichever is open and keeps it as the one to open on', () => {
  const closed = run([{ type: 'settings_open' }, { type: 'hub_close' }])

  assert.equal(hubPage(closed), null)
  assert.equal(closed.settings.open, false)
  assert.equal(closed.hub.last, 'settings')
  assert.equal(run([{ type: 'hub_close' }]), initialState, 'nothing open: nothing changes')
})

test('what was typed in search stays when another page is shown and search comes back', () => {
  const state = run([
    { type: 'history_open' }, { type: 'history_query', query: '对账' },
    { type: 'settings_open' }, { type: 'history_open' },
  ])

  assert.equal(state.history.query, '对账')
  assert.equal(hubPage(state), 'search')
})
