import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFeedActions } from '../src/renderer/feed-actions.ts'
import { initialState, reduce } from '../src/renderer/state.ts'

/** 动态 from the window (feed-actions.ts): loaded, an item into the conversation or let go, schedules by hand. */

const item = (id: string, seenAt: number | null = null) => ({ id, source: 'schedule', key: `${id}@t`, title: '周报', body: '草稿正文', origin: { label: '定时任务' }, createdAt: 0, seenAt })

function setup({ failing = '' } = {}) {
  let state = initialState as State
  let items = [item('i1'), item('i2', 5)]
  let schedules = [{ id: 's1', title: '日报', prompt: '写日报', kind: 'daily', nextAt: '2026-11-07T10:00:00.000Z', status: 'active' }]
  const calls: string[] = []
  const filled: string[] = []
  const sources: string[] = []
  const api = {
    listFeed: async () => items,
    listSchedules: async () => schedules,
    continueFeed: async (id: string) => {
      const found = items.find(item => item.id === id)
      if (failing || !found) throw new Error(failing || '结果已失效')
      return `来自动态的「${found.title}」\n\n${found.body}`
    },
    markFeedSeen: async (id: string) => {
      calls.push(`seen ${id}`)
      if (failing) throw new Error(failing)
      items = items.map((one) => (one.id === id ? { ...one, seenAt: 9 } : one))
    },
    pauseSchedule: async (id: string, paused: boolean) => {
      calls.push(`pause ${id} ${paused}`)
      schedules = schedules.map((one) => (one.id === id ? { ...one, status: paused ? 'paused' : 'active' } : one))
    },
    deleteSchedule: async (id: string) => {
      calls.push(`delete ${id}`)
      schedules = schedules.filter((one) => one.id !== id)
    },
  }
  const actions = createFeedActions({
    api: api as unknown as AgentApi, getState: () => state, dispatch: (action) => { state = reduce(state, action) },
    errorMessage: (err) => (err instanceof Error ? err.message : String(err)), fillComposer: (text, id) => { filled.push(text); sources.push(id) },
  })
  state = reduce(state, { type: 'feed_open' })
  return { actions, api, calls, filled, sources, state: () => state }
}

test('loaded: the items and the schedules together', async () => {
  const { actions, state } = setup()
  await actions.loadFeed()
  assert.deepEqual([state().feed.items.length, state().feed.schedules.length], [2, 1])
})

test('erasure invalidates an older feed query and a pending continuation with its exact item identity', async () => {
  const h = setup()
  await h.actions.loadFeed()
  type Feed = Awaited<ReturnType<typeof h.api.listFeed>>
  let finishQuery!: (items: Feed) => void, finishContinue!: (text: string) => void
  const stale = [item('i1'), item('i2')]
  h.api.listFeed = () => new Promise(resolve => { finishQuery = resolve })
  h.api.continueFeed = () => new Promise(resolve => { finishContinue = resolve })
  const query = h.actions.loadFeed()
  const continuation = h.actions.continueItem('i1')
  h.api.listFeed = async () => [item('i2')]
  await h.actions.erased(['i1'])
  finishQuery(stale)
  finishContinue('retired draft body')
  await Promise.all([query, continuation])
  assert.deepEqual(h.state().feed.items.map(item => item.id), ['i2'])
  assert.deepEqual(h.filled, [])
  assert.deepEqual(h.calls, [])
  h.api.continueFeed = async () => 'independent result'
  await h.actions.continueItem('i2')
  assert.deepEqual(h.filled, ['independent result'])
})

test('在对话里继续: the item into the input, and no longer new; one seen already goes in as it is', async () => {
  const { actions, calls, filled, sources, state } = setup()
  await actions.loadFeed()
  await actions.continueItem('i1')
  assert.equal(filled.length, 1)
  assert.match(filled[0], /周报[\s\S]*草稿正文$/)
  assert.deepEqual(calls, ['seen i1'])
  assert.notEqual(state().feed.items.find((one: { id: string }) => one.id === 'i1')?.seenAt, null)
  await actions.continueItem('i2')
  assert.deepEqual([filled.length, calls], [2, ['seen i1']])
  assert.deepEqual(sources, ['i1', 'i2'])
})

test('a refused continuation does not copy an outdated result to the composer', async () => {
  const { actions, calls, filled, state } = setup({ failing: '结果已失效' })
  await actions.loadFeed()
  await actions.continueItem('i1')
  assert.deepEqual([calls, filled, state().feed.error], [[], [], '结果已失效'])
})

test('不用了 lets it go; pause, resume and delete a schedule; a failure is said, and nothing goes twice at once', async () => {
  const { actions, calls, state } = setup()
  await actions.loadFeed()
  await actions.dismissItem('i1')
  await actions.pauseSchedule('s1', true)
  assert.equal(state().feed.schedules[0].status, 'paused')
  await actions.deleteSchedule('s1')
  assert.deepEqual([calls, state().feed.schedules], [['seen i1', 'pause s1 true', 'delete s1'], []])

  const failing = setup({ failing: '保存失败' })
  await failing.actions.loadFeed()
  const first = failing.actions.dismissItem('i1')
  await failing.actions.dismissItem('i1')
  await first
  assert.deepEqual([failing.calls, failing.state().feed.error, failing.state().feed.busy], [['seen i1'], '保存失败', false])
})
