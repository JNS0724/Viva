import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MAX_FEED_ITEMS, openFeedStore } from '../src/backend/feed-store.ts'

/** 动态's items (feed-store.ts): one shape for every source, one item per source and key. */

const item = (key: string, fields = {}) => ({ source: 'schedule', key, title: `提醒 ${key}`, body: '', origin: { label: '你周一说的' }, ...fields })

test('one thing makes one item, however often it is offered; another source\'s same key is another item', () => {
  let at = 0
  const store = openFeedStore({ db: new DatabaseSync(':memory:'), now: () => ++at })
  const first = store.add(item('f1@100'))
  const again = store.add(item('f1@100', { title: '换了标题' }))
  const mail = store.add(item('f1@100', { source: 'mail:work' }))
  assert.deepEqual([first.made, again.made, again.item.id === first.item.id, again.item.title, mail.made], [true, false, true, '提醒 f1@100', true])
  assert.deepEqual(store.list().map((entry) => entry.source), ['mail:work', 'schedule'], 'the latest first')
})

test('seen once, it stays seen; removed, it is gone; only the latest few hundred are kept', () => {
  let at = 0
  const store = openFeedStore({ db: new DatabaseSync(':memory:'), now: () => ++at })
  const { item: one } = store.add(item('a'))
  store.markSeen(one.id)
  const seenAt = store.list()[0].seenAt
  store.markSeen(one.id)
  assert.deepEqual([typeof seenAt, store.list()[0].seenAt], ['number', seenAt])
  store.remove(one.id)
  assert.deepEqual(store.list(), [])
  for (let i = 0; i < MAX_FEED_ITEMS + 3; i++) store.add(item(`k${i}`))
  const kept = store.list(MAX_FEED_ITEMS + 10)
  assert.deepEqual([kept.length, kept[0].key, kept.at(-1)?.key], [MAX_FEED_ITEMS, `k${MAX_FEED_ITEMS + 2}`, 'k3'])
})
