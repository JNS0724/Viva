import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { feedCount, feedGroups, feedLine, feedShown } from '../src/renderer/feed-state.ts'
import { hubPage } from '../src/renderer/hub-state.ts'

/** 动态 (feed-state.ts): what the app brings on its own, in three groups, its own page among the hub's. */

const item = (id: string, status: string, fields: Record<string, unknown> = {}) => ({ id, title: id, status, createdAt: 0, ...fields })
const withItems = (items: unknown[]) => reduce(initialState, { type: 'followups_loaded', view: { followups: items } })

test('new ones latest first, next ones soonest first, seen ones latest first and only the last few', () => {
  const seen = Array.from({ length: 25 }, (_, i) => item(`s${i}`, i % 2 ? 'done' : 'dismissed', { createdAt: i }))
  const state = withItems([
    item('r1', 'ready', { draftAt: 10 }), item('r2', 'ready', { draftAt: 20 }),
    item('n1', 'scheduled', { remindAt: 500 }), item('n2', 'preparing', { prepareBy: 100 }), item('n3', 'scheduled', { prepareBy: 300, remindAt: 900 }),
    ...seen,
  ])
  const { fresh, next, seen: listed } = feedGroups(state)
  assert.deepEqual([fresh.map((f) => f.id), next.map((f) => f.id)], [['r2', 'r1'], ['n2', 'n3', 'n1']])
  assert.deepEqual([listed.length, listed[0].id], [20, 's24'])
  assert.deepEqual([feedCount(state), feedLine(state)], [2, { fresh: 2, next: 3 }])
})

test('the one shown: the one picked while listed, else the first new one, else none', () => {
  const state = withItems([item('r1', 'ready', { draftAt: 1 }), item('n1', 'scheduled', { remindAt: 5 })])
  assert.equal(feedShown(state)?.id, 'r1')
  assert.equal(feedShown(reduce(state, { type: 'feed_select', id: 'n1' }))?.id, 'n1')
  assert.equal(feedShown(reduce(state, { type: 'feed_select', id: 'gone' }))?.id, 'r1', 'one no longer listed: the first new one')
  assert.equal(feedShown(withItems([item('n1', 'scheduled')])), null)
})

test('opened, it is the hub page shown and closes the island; another page opened closes it; it is not the page the profile icon opens on', () => {
  const opened = reduce(reduce(initialState, { type: 'toggle_island' }), { type: 'feed_open' })
  assert.deepEqual([hubPage(opened), opened.island, opened.feed.open], ['feed', false, true])
  assert.notEqual(opened.hub.last, 'feed')
  const settings = reduce(opened, { type: 'settings_open' })
  assert.deepEqual([hubPage(settings), settings.feed.open], ['settings', false])
  assert.equal(reduce(opened, { type: 'feed_close' }).feed.open, false)
})

test('what can be done with one opened: ready, continue or not; seen, its draft can still go into the conversation; scheduled, prepare now or delete', async () => {
  const { feedActionsOf, showsDraft, awaitsPreparation } = await import('../src/renderer/feed-state.ts')
  assert.deepEqual(feedActionsOf({ status: 'ready', draft: '草稿' }), ['continue', 'dismiss'])
  assert.deepEqual(feedActionsOf({ status: 'done', draft: '草稿' }), ['continue'], 'seen with a draft: looked back at, taken on')
  assert.deepEqual(feedActionsOf({ status: 'dismissed', draft: null }), [], 'seen with nothing kept: nothing to do, never 现在就准备')
  assert.deepEqual([feedActionsOf({ status: 'preparing' }), feedActionsOf({ status: 'scheduled' })], [['wake', 'delete'], ['prepare-now', 'delete']])
  assert.deepEqual([showsDraft({ status: 'done', draft: '草稿' }), showsDraft({ status: 'dismissed', draft: '草稿' }), showsDraft({ status: 'done', draft: null }), showsDraft({ status: 'scheduled', draft: '旧' })],
    [true, true, false, false])
  assert.deepEqual([awaitsPreparation({ status: 'done' }), awaitsPreparation({ status: 'scheduled' })], [false, true])
})

test('the home page\'s 今天 card opens 动态, where the follow-ups are', async () => {
  // Just enough of a document for view/dom.ts h(): elements with attributes, text, children and listeners.
  class FakeNode {}
  class FakeElement extends FakeNode {
    className = ''; textContent = ''; children: unknown[] = []; attrs: Record<string, string> = {}; listeners: Record<string, () => unknown> = {}
    tagName: string
    constructor(tagName: string) { super(); this.tagName = tagName }
    setAttribute(key: string, value: string) { this.attrs[key] = value }
    addEventListener(type: string, fn: () => unknown) { this.listeners[type] = fn }
    append(child: unknown) { this.children.push(child) }
  }
  const globals = globalThis as unknown as Record<string, unknown>
  const before = { document: globals.document, Node: globals.Node }
  globals.Node = FakeNode
  globals.document = { createElement: (tag: string) => new FakeElement(tag), createTextNode: (text: string) => Object.assign(new FakeNode(), { text }) }
  try {
    const { todayCard } = await import('../src/renderer/view/home.ts')
    const state = reduce(initialState, { type: 'followups_loaded', view: { followups: [item('r1', 'ready', { draftAt: 1 })] } })
    const opened: string[] = []
    const handlers = new Proxy({}, { get: (_target, name: string) => () => { opened.push(name) } })
    const card = todayCard(state, handlers as never, 0) as unknown as FakeElement
    const button = card.children.find((child) => child instanceof FakeElement && child.tagName === 'button') as FakeElement
    button.listeners.click()
    assert.deepEqual(opened, ['openFeed'])
  } finally {
    globals.document = before.document
    globals.Node = before.Node
  }
})
