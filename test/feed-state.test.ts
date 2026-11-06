import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { continueText, feedCount, feedGroups, feedLine, feedShown } from '../src/renderer/feed-state.ts'
import { hubPage } from '../src/renderer/hub-state.ts'

/** 动态 (feed-state.ts): new items, the schedules, seen items; its own page among the hub's. */

const item = (id: string, seenAt: number | null = null) => ({ id, source: 'schedule', key: `${id}@t`, title: id, body: `${id} 的内容`, origin: { label: '定时任务' }, createdAt: 0, seenAt })
const schedule = (id: string, nextAt: string, status = 'active') => ({ id, title: id, prompt: `${id} 的提示词`, kind: 'daily', nextAt, status })
const loaded = (items: unknown[], schedules: unknown[] = []) => reduce(initialState, { type: 'feed_loaded', items, schedules })

test('new items as listed (latest first), schedules soonest first with the paused last, seen items only the last few', () => {
  const seen = Array.from({ length: 25 }, (_, i) => item(`s${i}`, i + 1))
  const state = loaded([item('r2'), item('r1'), ...seen], [
    schedule('later', '2026-11-09T10:00:00Z'), schedule('paused', '2026-11-07T10:00:00Z', 'paused'), schedule('soon', '2026-11-07T09:00:00Z'),
  ])
  const { fresh, next, seen: listed } = feedGroups(state)
  assert.deepEqual([fresh.map((f) => f.id), next.map((f) => f.id)], [['r2', 'r1'], ['soon', 'later', 'paused']])
  assert.deepEqual([listed.length, listed[0].id], [20, 's0'])
  assert.deepEqual([feedCount(state), feedLine(state)], [2, { fresh: 2, next: 2 }], 'her line counts the active schedules only')
})

test('the one shown: the item or schedule picked while listed, else the first new item, else none', () => {
  const state = loaded([item('r1'), item('old', 5)], [schedule('d1', '2026-11-07T09:00:00Z')])
  assert.deepEqual(feedShown(state), { kind: 'item', item: item('r1'), fresh: true })
  assert.deepEqual(feedShown(reduce(state, { type: 'feed_select', kind: 'item', id: 'old' })), { kind: 'item', item: item('old', 5), fresh: false })
  assert.equal(feedShown(reduce(state, { type: 'feed_select', kind: 'schedule', id: 'd1' }))?.kind, 'schedule')
  assert.deepEqual(feedShown(reduce(state, { type: 'feed_select', kind: 'schedule', id: 'gone' })), { kind: 'item', item: item('r1'), fresh: true }, 'one no longer listed: the first new one')
  assert.equal(feedShown(loaded([], [schedule('d1', '2026-11-07T09:00:00Z')])), null)
})

test('opened, it is the hub page shown and closes the island; another page opened closes it; it is not the page the profile icon opens on', () => {
  const opened = reduce(reduce(initialState, { type: 'toggle_island' }), { type: 'feed_open' })
  assert.deepEqual([hubPage(opened), opened.island, opened.feed.open], ['feed', false, true])
  assert.notEqual(opened.hub.last, 'feed')
  const settings = reduce(opened, { type: 'settings_open' })
  assert.deepEqual([hubPage(settings), settings.feed.open], ['settings', false])
  assert.equal(reduce(opened, { type: 'feed_close' }).feed.open, false)
})

test('busy while a change goes; a failure says why and keeps what was listed; 在对话里继续 says where it came from', () => {
  const state = loaded([item('r1')])
  const busy = reduce(state, { type: 'feed_busy' })
  const failed = reduce(busy, { type: 'feed_failed', message: '保存失败' })
  assert.deepEqual([busy.feed.busy, failed.feed.busy, failed.feed.error, failed.feed.items.length], [true, false, '保存失败', 1])
  assert.equal(reduce(failed, { type: 'feed_loaded', items: [] }).feed.error, null)
  assert.match(continueText({ title: '周报', body: '草稿正文' }), /周报[\s\S]*草稿正文$/)
})

test('the home page\'s 今天 card counts what is new in 动态 and opens it', async () => {
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
    const state = loaded([item('r1')])
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
