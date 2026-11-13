import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { capabilityCounts, capabilityFeedback, capabilityProblems, shownSource } from '../src/renderer/capabilities-state.ts'
import { offersSources, sourceStanding } from '../src/renderer/sources-state.ts'
import { createSourceActions } from '../src/renderer/sources-actions.ts'
import type { SourceView } from '../src/renderer/capability-types.ts'
import { t } from '../src/shared/i18n/translate.ts'

/** 能力 · 消息源 and 动态's hint in the window (sources-state.ts, sources-actions.ts). Synthetic data only. */

const STATUS = { checkedAt: null, nextAt: null, fresh: 0, pushed: 0, error: '' }
const source = (id: string, over: Partial<SourceView> = {}): SourceView => ({
  id, name: `源 ${id}`, tool: 'mcp__labmail__search_unread', judge: '重要的', everyMinutes: 15, paused: false, createdAt: 0, lastCheckedAt: null, status: STATUS, ...over,
})

test('a source stands paused, failed (on, its last check failed) or on; a failed one counts as a problem and is shown first', () => {
  const failing = source('b', { status: { ...STATUS, error: '找不到工具' } })
  const pausedFailing = source('c', { paused: true, status: { ...STATUS, error: 'x' } })
  assert.deepEqual(sourceStanding(source('a')), { kind: 'on' })
  assert.deepEqual(sourceStanding(failing), { kind: 'failed', reason: '找不到工具' })
  assert.deepEqual(sourceStanding(pausedFailing), { kind: 'paused' })
  const state = reduce({ ...initialState, capabilities: { ...initialState.capabilities, tab: 'sources' } } as State, { type: 'sources_loaded', list: [source('a'), failing, pausedFailing] })
  assert.equal(capabilityCounts(state).sources, 3)
  assert.equal(capabilityProblems(state), 1)
  assert.equal(shownSource(state)?.id, 'b')
  assert.equal(shownSource(reduce(state, { type: 'capabilities_select', id: 'a' }))?.id, 'a')
})

test('动态 offers to add a source only once the list is known and empty', () => {
  const state = initialState as State
  assert.equal(offersSources(state), false)
  assert.equal(offersSources(reduce(state, { type: 'sources_loaded', list: [] })), true)
  assert.equal(offersSources(reduce(state, { type: 'sources_loaded', list: [source('a')] })), false)
})

function setup({ failing = '' } = {}) {
  let state = initialState as State
  let list = [source('a')]
  const calls: string[] = []
  const filled: string[] = []
  const api = {
    listSources: async () => list,
    pauseSource: async (id: string, paused: boolean) => {
      calls.push(`pause ${id} ${paused}`)
      if (failing) throw new Error(failing)
      list = list.map((one) => (one.id === id ? { ...one, paused } : one))
      return list
    },
    deleteSource: async (id: string) => {
      calls.push(`delete ${id}`)
      list = list.filter((one) => one.id !== id)
      return list
    },
  }
  const actions = createSourceActions({
    api: api as never, getState: () => state, dispatch: (action) => { state = reduce(state, action) },
    errorMessage: (err) => (err instanceof Error ? err.message : String(err)), fillComposer: (text) => filled.push(text),
  })
  return { actions, calls, filled, state: () => state }
}

test('the window loads, pauses and deletes sources; adding one starts in the conversation', async () => {
  const { actions, calls, filled, state } = setup()
  await actions.loadSources()
  assert.equal(state().sources.loaded, true)
  await actions.pauseSource('a', true)
  assert.equal((state().sources.list as readonly SourceView[])[0].paused, true)
  await actions.deleteSource('a')
  assert.deepEqual(state().sources.list, [])
  assert.deepEqual(calls, ['pause a true', 'delete a'])
  actions.addSource()
  assert.deepEqual(filled, [t('sources.prompt')])
})

test('a change that fails says why on the sources tab', async () => {
  const { actions, state } = setup({ failing: '这个消息源已经不在了。' })
  await actions.loadSources()
  await actions.pauseSource('a', true)
  const shown = { ...state(), capabilities: { ...state().capabilities, tab: 'sources' } } as State
  assert.deepEqual(capabilityFeedback(shown), { error: '这个消息源已经不在了。', notice: null })
  assert.equal(state().sources.busy, false)
})
