import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { feedGroups, feedShown, isSourceDraftDirty, NEW_SOURCE_ID, scheduleFromDraft, type FeedSourceView } from '../src/renderer/feed-state.ts'
import { createFeedActions } from '../src/renderer/feed-actions.ts'
import { newSourceDetail, sourceDetail } from '../src/renderer/view/feed-source-panel.ts'

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
      plugins: [
        { name: '@company/dsh-plugin-unsupported', version: '1.0.0', description: 'no tools', enabled: true, removable: true, error: null, fit: { kind: 'no-conflict' }, feedSourceTools: [], rows: [], overrides: [] },
        { name: '@company/dsh-plugin-mail', version: '1.0.0', description: 'mail', enabled: true, removable: true, error: null, fit: { kind: 'no-conflict' }, feedSourceTools: ['mail_search'], rows: [], overrides: [] },
      ],
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

test('sourceDetail populates saved instruction into textarea and associates labels with controls', () => {
  class FakeEl {
    tag: string
    className = ''
    textContent = ''
    attrs = new Map<string, string>()
    children: FakeEl[] = []
    constructor(tag: string) { this.tag = tag }
    setAttribute(k: string, v: string) { this.attrs.set(k, v) }
    addEventListener() {}
    append(...nodes: unknown[]) {
      for (const n of nodes) if (n instanceof FakeEl) this.children.push(n)
    }
    findAll(pred: (el: FakeEl) => boolean): FakeEl[] {
      const out: FakeEl[] = pred(this) ? [this] : []
      for (const c of this.children) out.push(...c.findAll(pred))
      return out
    }
  }
  const prevDoc = globalThis.document
  const prevNode = globalThis.Node
  ;(globalThis as unknown as { document: unknown, Node: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (text: string) => new FakeEl(`#text:${text}`),
  }
  ;(globalThis as unknown as { Node: unknown }).Node = FakeEl
  try {
    const src = sampleSource('fs1')
    const editState = reduce(
      reduce(initialState, { type: 'feed_loaded', items: [], schedules: [], sources: [src] }),
      { type: 'feed_select', kind: 'source', id: 'fs1' },
    )
    const editRoot = sourceDetail(src, editState, {}, Date.parse('2026-11-19T12:00:00+08:00')) as unknown as FakeEl
    const textarea = editRoot.findAll((el) => el.tag === 'textarea')[0]
    assert.ok(textarea, 'textarea rendered')
    assert.equal(textarea.textContent, '筛选紧急邮件', 'existing instruction populated via textContent')
    assert.equal(textarea.attrs.get('id'), 'fs-fs1-rule')
    const editLabels = editRoot.findAll((el) => el.tag === 'label').map((el) => el.attrs.get('for'))
    assert.ok(editLabels.includes('fs-fs1-name'))
    assert.ok(editLabels.includes('fs-fs1-rule'))

    const addState = reduce(
      reduce(initialState, {
        type: 'plugins_loaded',
        view: {
          connected: true,
          plugins: [
            { name: '@company/dsh-plugin-mail', version: '1.0.0', description: 'mail', enabled: true, removable: true, error: null, fit: { kind: 'no-conflict' }, feedSourceTools: ['mail_search'], rows: [], overrides: [] },
            { name: '@company/dsh-plugin-plain', version: '1.0.0', description: 'plain', enabled: true, removable: true, error: null, fit: { kind: 'no-conflict' }, feedSourceTools: [], rows: [], overrides: [] },
          ],
        },
      }),
      { type: 'feed_source_new', pluginName: '@company/dsh-plugin-mail' },
    )
    const addRoot = newSourceDetail(addState, {}) as unknown as FakeEl
    const addLabels = addRoot.findAll((el) => el.tag === 'label').map((el) => el.attrs.get('for'))
    assert.ok(addLabels.includes('fs-new-plugin'))
    assert.ok(addLabels.includes('fs-new-name'))
    assert.ok(addLabels.includes('fs-new-rule'))
    assert.ok(addRoot.findAll((el) => el.tag === 'select' && el.attrs.get('id') === 'fs-new-plugin').length === 1)
    const unsupportedOpt = addRoot.findAll((el) => el.tag === 'option' && el.attrs.get('value') === '@company/dsh-plugin-plain')[0]
    assert.ok(unsupportedOpt?.attrs.has('disabled'), 'unsupported enabled plugin is disabled in selector')
  } finally {
    ;(globalThis as unknown as { document: unknown, Node: unknown }).document = prevDoc
    ;(globalThis as unknown as { Node: unknown }).Node = prevNode
  }
})
