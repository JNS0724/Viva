import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { feedGroups, feedShown, isSourceDraftDirty, NEW_SOURCE_ID, scheduleFromDraft, type FeedSourceView } from '../src/renderer/feed-state.ts'
import { createFeedActions } from '../src/renderer/feed-actions.ts'

const sampleSource = (id = 'fs1'): FeedSourceView => ({
  id,
  pluginName: '@company/dsh-plugin-mail',
  name: '客户紧急邮件',
  instruction: '筛选紧急邮件',
  schedule: { kind: 'interval', minutes: 30, timeZone: 'Asia/Shanghai' },
  status: 'active',
  nextAt: '2026-11-19T04:30:00.000Z',
  lastRunAt: null,
  lastStatus: 'idle',
  lastMessage: null,
  lastPublishedCount: 0,
  createdAt: 100,
  updatedAt: 100,
})

test('feed-state selects data sources, opens new-source form, and tracks draft edits immutably', () => {
  const src = sampleSource('fs1')
  let state = reduce(initialState, { type: 'feed_loaded', items: [], schedules: [], sources: [src] })
  assert.equal(feedGroups(state).sources.length, 1)

  state = reduce(state, { type: 'feed_select', kind: 'source', id: 'fs1' })
  assert.deepEqual(feedShown(state), { kind: 'source', source: src })
  assert.equal(isSourceDraftDirty(state.feed.draft, src), false)

  state = reduce(state, { type: 'feed_source_draft', changes: { freqKind: 'daily', time: '08:30' } })
  assert.equal(isSourceDraftDirty(state.feed.draft, src), true)
  assert.deepEqual(scheduleFromDraft(state.feed.draft!, 'Asia/Shanghai'), { kind: 'daily', time: '08:30', timeZone: 'Asia/Shanghai' })

  state = reduce(state, { type: 'feed_source_new', pluginName: '@company/dsh-plugin-github' })
  assert.deepEqual(feedShown(state), { kind: 'new-source' })
  assert.equal(state.feed.selected?.id, NEW_SOURCE_ID)
  assert.equal(state.feed.draft?.pluginName, '@company/dsh-plugin-github')
})

test('feed-actions creates, updates, pauses, runs now and deletes plugin data sources', async () => {
  let state = reduce(initialState, {
    type: 'plugins_loaded',
    view: {
      connected: true,
      plugins: [{ name: '@company/dsh-plugin-mail', version: '1.0.0', description: 'mail', enabled: true, removable: true, error: null, fit: { kind: 'no-conflict' }, rows: [], overrides: [] }],
    },
  })
  const dispatch = (action: Action) => { state = reduce(state, action) }
  let sources: FeedSourceView[] = []
  const api = {
    listFeed: async () => [],
    listSchedules: async () => [],
    listFeedSources: async () => [...sources],
    createFeedSource: async (input: Record<string, unknown>) => {
      const created = { ...sampleSource('fs1'), name: String(input.name ?? input.pluginName) }
      sources = [created]
      return created
    },
    updateFeedSource: async (id: string, changes: Record<string, unknown>) => {
      sources = sources.map((s) => (s.id === id ? { ...s, name: String(changes.name ?? s.name), updatedAt: s.updatedAt + 1 } : s))
      return sources[0]
    },
    pauseFeedSource: async (id: string, paused: boolean) => {
      sources = sources.map((s) => (s.id === id ? { ...s, status: paused ? 'paused' : 'active' } : s))
      return sources[0]
    },
    deleteFeedSource: async (id: string) => {
      sources = sources.filter((s) => s.id !== id)
      return { deleted: true }
    },
    runFeedSourceNow: async (id: string) => {
      return { status: 'published' as const, publishedCount: 1, message: null, source: sources.find((s) => s.id === id)! }
    },
  } as unknown as AgentApi

  const actions = createFeedActions({
    api,
    getState: () => state,
    dispatch,
    errorMessage: (err) => (err instanceof Error ? err.message : String(err)),
    fillComposer: () => {},
  })

  await actions.openNewSource()
  assert.equal(state.feed.draft?.pluginName, '@company/dsh-plugin-mail')

  await actions.createSource({
    pluginName: '@company/dsh-plugin-mail',
    name: '客户邮件',
    instruction: '查紧急邮件',
    schedule: { kind: 'interval', minutes: 30, timeZone: 'Asia/Shanghai' },
  })
  assert.equal(state.feed.sources.length, 1)
  assert.deepEqual(state.feed.selected, { kind: 'source', id: 'fs1' })

  await actions.updateSource('fs1', { name: '高优客户邮件' })
  assert.equal(state.feed.sources[0].name, '高优客户邮件')

  await actions.pauseSource('fs1', true)
  assert.equal(state.feed.sources[0].status, 'paused')

  await actions.runSourceNow('fs1')
  assert.equal(state.feed.runningSourceId, null)
  assert.ok(state.feed.notice)

  await actions.deleteSource('fs1')
  assert.equal(state.feed.sources.length, 0)
})
