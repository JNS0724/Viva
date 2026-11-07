import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCapabilityActions } from '../src/renderer/capability-actions.ts'

/** 能力 (capability-actions.ts): opening it reads skills, servers and plugins afresh; the rest is the page's own. */

function setup() {
  const dispatched: Action[] = []
  let loads = 0
  const actions = createCapabilityActions({ dispatch: (action) => { dispatched.push(action) }, load: () => { loads++ } })
  return { actions, dispatched, loads: () => loads }
}

test('opening reads what the agent has afresh, on the tab and item asked for', () => {
  const { actions, dispatched, loads } = setup()
  actions.openCapabilities('mcp', 'github')
  assert.deepEqual(dispatched, [{ type: 'capabilities_open', tab: 'mcp', id: 'github' }])
  assert.equal(loads(), 1)
  actions.refreshCapabilities()
  assert.equal(loads(), 2, 'the hub opening reads them too, for the count on the way in')
})

test('tabs, picks and the search are the page\'s own: nothing is read', () => {
  const { actions, dispatched, loads } = setup()
  actions.capabilityTab('plugins')
  actions.selectCapability('p1')
  actions.searchSkills('周报')
  assert.deepEqual(dispatched, [
    { type: 'capabilities_tab', tab: 'plugins' },
    { type: 'capabilities_select', id: 'p1' },
    { type: 'capabilities_query', query: '周报' },
  ])
  assert.equal(loads(), 0)
})
