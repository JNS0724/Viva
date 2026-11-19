import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { openFeedStore, type FeedItem } from '../src/backend/feed-store.ts'
import { openFeedSourceStore } from '../src/backend/feed-source-store.ts'
import {
  buildFeedSourcePrompt, createFeedSourceRuns, MAX_ATTEMPTS, MAX_ITEMS_PER_RUN,
  parseFeedSourceOutput, RETRY_MS, type PluginCheckResult,
} from '../src/backend/feed-source-runs.ts'
import type { RunResult } from '../src/backend/unattended-runs.ts'

const at = (iso: string) => Date.parse(iso)
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function harness(start: string, { checkPlugin, run }: {
  checkPlugin?: (name: string) => Promise<PluginCheckResult>
  run: (prompt: string, cwd: string) => Promise<RunResult>
}) {
  const db = new DatabaseSync(':memory:')
  let now = at(start)
  let nextSourceId = 0
  let nextFeedId = 0
  let scheduled: { fn: () => void, at: number } | null = null
  const kept: FeedItem[] = []
  let deliveredCount = 0
  const store = openFeedSourceStore({ db, now: () => now, newId: () => `fs${++nextSourceId}` })
  const feed = openFeedStore({ db, now: () => now, newId: () => `fi${++nextFeedId}` })
  const runs = createFeedSourceRuns({
    db,
    store,
    feed,
    checkPlugin: checkPlugin ?? (async () => ({ ok: true })),
    run,
    keep: (item) => kept.push(item),
    delivered: () => { deliveredCount += 1 },
    now: () => now,
    later: (fn, ms) => {
      const handle = { fn, at: now + ms }
      scheduled = handle
      return handle
    },
    cancel: (handle) => { if (scheduled === handle) scheduled = null },
  })
  async function advance(isoOrMs: string | number) {
    now = typeof isoOrMs === 'string' ? at(isoOrMs) : now + isoOrMs
    if (scheduled && scheduled.at <= now) {
      const fn = scheduled.fn
      scheduled = null
      fn()
    }
    await flush()
    await flush()
  }
  return { db, store, feed, runs, kept, deliveredCount: () => deliveredCount, advance, setNow: (iso: string) => { now = at(iso) } }
}

test('parseFeedSourceOutput handles publish, skip, item caps and plain-text fallback', () => {
  const pub = parseFeedSourceOutput('```json\n{"action":"publish","items":[{"key":"m1","title":"紧急","body":"内容","ref":"msg://1"}],"cursor":{"id":"m1"}}\n```', '默认标题')
  assert.equal(pub.kind, 'publish')
  if (pub.kind === 'publish') {
    assert.equal(pub.items.length, 1)
    assert.deepEqual(pub.items[0], { key: 'm1', title: '紧急', body: '内容', ref: 'msg://1' })
    assert.deepEqual(pub.cursor, { id: 'm1' })
  }

  const skip = parseFeedSourceOutput('{"action":"skip","reason":"无未读邮件","cursor":12}', '默认标题')
  assert.deepEqual(skip, { kind: 'skip', reason: '无未读邮件', cursor: 12 })

  const many = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, body: `b${i}` }))
  const capped = parseFeedSourceOutput(JSON.stringify({ action: 'publish', items: many }), '默认')
  assert.equal(capped.kind, 'publish')
  if (capped.kind === 'publish') assert.equal(capped.items.length, MAX_ITEMS_PER_RUN)

  const fallback = parseFeedSourceOutput('这是一段直接总结的正文', '邮件监控')
  assert.deepEqual(fallback, { kind: 'publish', items: [{ title: '邮件监控', body: '这是一段直接总结的正文' }] })
})

test('scheduled source runs when due, publishes deduplicated feed items and saves cursor', async () => {
  const prompts: string[] = []
  const h = harness('2026-11-19T12:00:00+08:00', {
    run: async (prompt) => {
      prompts.push(prompt)
      return {
        ok: true,
        text: '```json\n{"action":"publish","items":[{"key":"mail-42","title":"客户合同催办","body":"请今天确认","ref":"mail://42"}],"cursor":{"lastUid":42}}\n```',
      }
    },
  })
  const source = h.store.create({
    pluginName: '@company/dsh-plugin-mail',
    name: '客户紧急邮件',
    instruction: '筛选客户紧急邮件',
    schedule: { kind: 'interval', minutes: 30, timeZone: 'Asia/Shanghai' },
    cwd: '/work',
  })
  h.runs.arm()

  await h.advance('2026-11-19T12:30:01+08:00')
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /@company\/dsh-plugin-mail/)
  assert.match(prompts[0], /筛选客户紧急邮件/)
  assert.equal(h.feed.list().length, 1)
  assert.equal(h.feed.list()[0].source, `source:${source.id}`)
  assert.equal(h.feed.list()[0].origin.label, '客户紧急邮件')
  assert.equal(h.kept.length, 1)
  assert.equal(h.deliveredCount(), 1)
  assert.deepEqual(h.store.get(source.id)?.cursor, { lastUid: 42 })
  assert.equal(h.store.get(source.id)?.lastStatus, 'published')

  // Next occurrence returns the exact same item key: deduplicated, no second feed item or notice
  await h.advance('2026-11-19T13:00:01+08:00')
  assert.equal(h.feed.list().length, 1)
  assert.equal(h.kept.length, 1)
  assert.equal(h.store.get(source.id)?.lastStatus, 'skipped')
  assert.match(prompts[1], /"lastUid":42/, 'cursor passed into next prompt')
})

test('skip outcome records status quietly without creating a feed item or notice', async () => {
  const h = harness('2026-11-19T12:00:00+08:00', {
    run: async () => ({ ok: true, text: '{"action":"skip","reason":"没有新消息"}' }),
  })
  const source = h.store.create({
    pluginName: '@company/dsh-plugin-im',
    name: '群聊监控',
    instruction: '只看故障告警',
    schedule: { kind: 'interval', minutes: 15, timeZone: 'Asia/Shanghai' },
    cwd: '/work',
  })
  h.runs.arm()

  await h.advance('2026-11-19T12:15:01+08:00')
  assert.equal(h.feed.list().length, 0)
  assert.equal(h.kept.length, 0)
  assert.equal(h.store.get(source.id)?.lastStatus, 'skipped')
  assert.equal(h.store.get(source.id)?.lastMessage, '没有新消息')
})

test('disabled plugin skips model call and marks source plugin_unavailable', async () => {
  let modelCalls = 0
  const h = harness('2026-11-19T12:00:00+08:00', {
    checkPlugin: async () => ({ ok: false, reason: '插件未启用' }),
    run: async () => { modelCalls += 1; return { ok: true, text: 'should not run' } },
  })
  const source = h.store.create({
    pluginName: '@company/dsh-plugin-im',
    name: '群聊监控',
    instruction: '看消息',
    schedule: { kind: 'interval', minutes: 15, timeZone: 'Asia/Shanghai' },
    cwd: '/work',
  })
  h.runs.arm()

  await h.advance('2026-11-19T12:15:01+08:00')
  assert.equal(modelCalls, 0)
  assert.equal(h.store.get(source.id)?.lastStatus, 'plugin_unavailable')
  assert.equal(h.store.get(source.id)?.lastMessage, '插件未启用')
})

test('dsh unavailable waits for wake without burning attempts, and failures retry up to MAX_ATTEMPTS', async () => {
  let mode: 'unavailable' | 'fail' = 'unavailable'
  let calls = 0
  const h = harness('2026-11-19T12:00:00+08:00', {
    run: async () => {
      calls += 1
      return mode === 'unavailable' ? { ok: false, unavailable: true, problem: 'down' } : { ok: false, problem: 'network boom' }
    },
  })
  const source = h.store.create({
    pluginName: '@company/dsh-plugin-rss',
    name: '订阅',
    instruction: '抓新闻',
    schedule: { kind: 'interval', minutes: 30, timeZone: 'Asia/Shanghai' },
    cwd: '/work',
  })
  h.runs.arm()

  await h.advance('2026-11-19T12:30:01+08:00')
  assert.equal(calls, 1)
  assert.equal(h.store.get(source.id)?.lastStatus, 'idle')

  mode = 'fail'
  h.runs.wake()
  await flush()
  await flush()
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    await h.advance(RETRY_MS * attempt + 10)
  }
  assert.equal(calls, 1 + MAX_ATTEMPTS)
  assert.equal(h.store.get(source.id)?.lastStatus, 'failed')
  assert.equal(h.store.get(source.id)?.lastMessage, 'network boom')
})

test('runNow executes immediately and returns published summary without waiting for timer', async () => {
  const h = harness('2026-11-19T12:00:00+08:00', {
    run: async () => ({ ok: true, text: '{"action":"publish","items":[{"title":"即时结果","body":"测试通过"}]}' }),
  })
  const source = h.store.create({
    pluginName: '@company/dsh-plugin-github',
    name: 'GitHub',
    instruction: '查 PR',
    schedule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
    cwd: '/work',
  })
  const result = await h.runs.runNow(source.id)
  assert.equal(result.status, 'published')
  assert.equal(result.publishedCount, 1)
  assert.equal(h.feed.list().length, 1)
  assert.equal(h.feed.list()[0].title, '即时结果')
})

test('buildFeedSourcePrompt includes plugin name, instruction and prior cursor', () => {
  const prompt = buildFeedSourcePrompt({
    pluginName: '@company/dsh-plugin-mail',
    name: '邮件',
    instruction: '只看客户邮件',
    lastRunAt: at('2026-11-19T12:00:00Z'),
    cursor: { uid: 7 },
  }, at('2026-11-19T12:30:00Z'))
  assert.match(prompt, /@company\/dsh-plugin-mail/)
  assert.match(prompt, /只看客户邮件/)
  assert.match(prompt, /"uid":7/)
})
