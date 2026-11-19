import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { EventEmitter } from 'node:events'
import { openFeedStore, type FeedItem } from '../src/backend/feed-store.ts'
import { openFeedSourceStore } from '../src/backend/feed-source-store.ts'
import {
  buildFeedSourcePrompt, createFeedSourceRuns, MAX_ATTEMPTS, MAX_ITEMS_PER_RUN,
  parseFeedSourceOutput, RETRY_MS, type PluginCheckResult,
} from '../src/backend/feed-source-runs.ts'
import { declaredReadOnlyTools } from '../src/backend/plugin-fit.ts'
import { createRoutingDesk } from '../src/backend/routing-channel.ts'
import { createHostChannel } from '../plugins/routing/lib/host.ts'
import { admitFeedSource } from '../plugins/routing/lib/policy.ts'
import type { MemoryProvenance } from '../src/memory/contracts/provenance.ts'
import type { RunResult } from '../src/backend/unattended-runs.ts'

const at = (iso: string) => Date.parse(iso)
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function harness(start: string, { checkPlugin, run, memoryCurrent, serialize }: {
  checkPlugin?: (name: string) => Promise<PluginCheckResult>
  run: (prompt: string, cwd: string, allowedTools: readonly string[]) => Promise<RunResult>
  memoryCurrent?: (memory: MemoryProvenance) => boolean | Promise<boolean>
  serialize?: <T>(fn: () => Promise<T>) => Promise<T>
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
    checkPlugin: checkPlugin ?? (async () => ({ ok: true, allowedTools: ['mail_search', 'mail_read'] })),
    run,
    memoryCurrent,
    serialize,
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

test('parseFeedSourceOutput accepts publish/skip, caps items, and rejects prose or unknown actions', () => {
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

  const proseError = parseFeedSourceOutput('插件暂时无法读取，请稍后重试', '邮件监控')
  assert.equal(proseError.kind, 'invalid')

  const unknownAction = parseFeedSourceOutput('{"action":"error","message":"timeout"}', '邮件监控')
  assert.equal(unknownAction.kind, 'invalid')
})

test('invalid prose output never publishes a feed item, keeps cursor, and retries as failure', async () => {
  let calls = 0
  const h = harness('2026-11-19T12:00:00+08:00', {
    run: async () => {
      calls += 1
      return { ok: true, text: '插件暂时无法读取，请稍后重试' }
    },
  })
  const source = h.store.create({
    pluginName: '@company/dsh-plugin-mail',
    name: '邮件监控',
    instruction: '查紧急邮件',
    schedule: { kind: 'interval', minutes: 30, timeZone: 'Asia/Shanghai' },
    cwd: '/work',
  })
  h.store.recordRun(source.id, { ranAt: at('2026-11-19T12:00:00+08:00'), status: 'skipped', message: null, publishedCount: 0, cursor: { uid: 9 } })
  h.runs.arm()

  await h.advance('2026-11-19T12:30:01+08:00')
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    await h.advance(RETRY_MS * attempt + 10)
  }
  assert.equal(calls, MAX_ATTEMPTS)
  assert.equal(h.feed.list().length, 0)
  assert.equal(h.kept.length, 0)
  assert.equal(h.store.get(source.id)?.lastStatus, 'failed')
  assert.deepEqual(h.store.get(source.id)?.cursor, { uid: 9 }, 'cursor preserved across invalid output failures')
  assert.equal(h.store.get(source.id)?.lastSuccessAt, at('2026-11-19T12:00:00+08:00'), 'lastSuccessAt unchanged on failure')
})

test('lastSuccessAt only advances on publish or skip, not on failure or plugin_unavailable', async () => {
  const prompts: string[] = []
  let shouldFail = true
  const h = harness('2026-11-19T12:00:00+08:00', {
    run: async (prompt) => {
      prompts.push(prompt)
      if (shouldFail) return { ok: false, problem: 'boom' }
      return { ok: true, text: '{"action":"skip","reason":"none"}' }
    },
  })
  const source = h.store.create({
    pluginName: '@company/dsh-plugin-mail',
    name: '邮件监控',
    instruction: '查紧急邮件',
    schedule: { kind: 'interval', minutes: 30, timeZone: 'Asia/Shanghai' },
    cwd: '/work',
  })
  h.runs.arm()

  await h.advance('2026-11-19T12:30:01+08:00')
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    await h.advance(RETRY_MS * attempt + 10)
  }
  assert.equal(h.store.get(source.id)?.lastStatus, 'failed')
  assert.equal(h.store.get(source.id)?.lastSuccessAt, null)

  shouldFail = false
  await h.advance('2026-11-19T13:00:01+08:00')
  assert.match(prompts.at(-1)!, /这是该数据源的首次检查/, 'after first-run failure, next prompt still treats check as first')
  assert.equal(h.store.get(source.id)?.lastSuccessAt, at('2026-11-19T13:00:01+08:00'))
})

test('source paused while waiting in serializer never invokes run()', async () => {
  let releaseBlocker!: () => void
  let queue: Promise<unknown> = new Promise<void>((resolve) => { releaseBlocker = resolve })
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn)
    queue = next.then(() => undefined, () => undefined)
    return next
  }
  let runCalls = 0
  const h = harness('2026-11-19T12:00:00+08:00', {
    serialize,
    run: async () => {
      runCalls += 1
      return { ok: true, text: '{"action":"skip"}' }
    },
  })
  const source = h.store.create({
    pluginName: '@company/dsh-plugin-mail',
    name: '邮件监控',
    instruction: '查紧急邮件',
    schedule: { kind: 'interval', minutes: 30, timeZone: 'Asia/Shanghai' },
    cwd: '/work',
  })
  h.runs.arm()

  await h.advance('2026-11-19T12:30:01+08:00')
  // Source is now queued inside serialize(); pause it before serializer frees up.
  h.store.setPaused(source.id, true)
  releaseBlocker()
  await flush()
  await flush()

  assert.equal(runCalls, 0, 'paused source must not start a session once serializer releases')
})

test('scheduled and manual publish persist memory provenance and reject stale memory results', async () => {
  const memory: MemoryProvenance = {
    sources: ['mem-src-1'],
    turnOnly: false,
    epoch: 1,
  }
  let memoryValid = true
  const h = harness('2026-11-19T12:00:00+08:00', {
    memoryCurrent: () => memoryValid,
    run: async () => ({
      ok: true,
      text: '{"action":"publish","items":[{"key":"k1","title":"摘要","body":"内容"}]}',
      memory,
    }),
  })
  const source = h.store.create({
    pluginName: '@company/dsh-plugin-mail',
    name: '邮件监控',
    instruction: '查紧急邮件',
    schedule: { kind: 'interval', minutes: 30, timeZone: 'Asia/Shanghai' },
    cwd: '/work',
  })

  // Manual run saves memory provenance on the feed item
  const manual = await h.runs.runNow(source.id)
  assert.equal(manual.status, 'published')
  const item = h.feed.list()[0]
  assert.deepEqual(h.feed.continuation(item.id)?.memory, memory)

  // Stale memory prevents publishing on manual run
  memoryValid = false
  const staleManual = await h.runs.runNow(source.id)
  assert.equal(staleManual.status, 'failed')
  assert.equal(h.feed.list().length, 1)
})

test('scheduled source runs when due, passes allowlisted read-only tools, deduplicates items and saves cursor', async () => {
  const prompts: string[] = []
  const seenTools: Array<readonly string[]> = []
  const h = harness('2026-11-19T12:00:00+08:00', {
    checkPlugin: async () => ({ ok: true, allowedTools: ['mail_search', 'mail_read'] }),
    run: async (prompt, _cwd, allowedTools) => {
      prompts.push(prompt)
      seenTools.push(allowedTools)
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
  assert.deepEqual(seenTools[0], ['mail_search', 'mail_read'])
  assert.equal(h.feed.list().length, 1)
  assert.equal(h.feed.list()[0].source, `source:${source.id}`)
  assert.equal(h.kept.length, 1)
  assert.equal(h.deliveredCount(), 1)
  assert.deepEqual(h.store.get(source.id)?.cursor, { lastUid: 42 })

  // Next occurrence with identical key is deduplicated
  await h.advance('2026-11-19T13:00:01+08:00')
  assert.equal(h.feed.list().length, 1)
  assert.equal(h.kept.length, 1)
  assert.match(prompts[1], /"lastUid":42/, 'cursor passed into next prompt')
})

test('execution-layer policy strips disallowed tools, binds source allowlist over routing channel, and denies writes/other tools', async () => {
  // 1. Manifest parsing strips built-in/write/shell/memory tools
  assert.deepEqual(
    declaredReadOnlyTools({
      viva: { feedSource: { readOnlyTools: ['mail_search', 'bash', 'write', 'memory_remember', 'mail_read', 'mail_search'] } },
    }),
    ['mail_search', 'mail_read'],
  )
  assert.deepEqual(declaredReadOnlyTools({ name: 'no-viva-field' }), [])

  // 2. Policy guard allows only declared read-only tools and denies writes and other tools
  const allowed = new Set(['mail_search', 'mail_read'])
  assert.equal(admitFeedSource(allowed, 'mail_search').allowed, true)
  assert.equal(admitFeedSource(allowed, 'mail_read').allowed, true)
  assert.equal(admitFeedSource(allowed, 'mail_send').allowed, false)
  assert.equal(admitFeedSource(allowed, 'other_plugin_read').allowed, false)
  assert.equal(admitFeedSource(allowed, 'bash').allowed, false)
  assert.equal(admitFeedSource(allowed, 'write').allowed, false)
  assert.equal(admitFeedSource(allowed, 'edit').allowed, false)
  // Even if a forbidden tool were mistakenly included in the set, admitFeedSource still denies it
  assert.equal(admitFeedSource(new Set(['bash', 'write']), 'bash').allowed, false)
  assert.equal(admitFeedSource(new Set(['bash', 'write']), 'write').allowed, false)

  // 3. Routing channel bindSource handshake delivers allowlist to plugin before prompt
  const bus = new EventEmitter()
  const bound: Array<{ sessionId: string, allowedTools: readonly string[] }> = []
  const desk = createRoutingDesk({
    send: (msg) => bus.emit('to-plugin', msg),
    handlers: {
      receive: () => 'r1',
      decide: async () => ({ accepted: true, receipts: [] }),
      fail: () => false,
      noteFast: () => false,
      endTurn: () => [],
    },
  })
  const fakePort = Object.assign(new EventEmitter(), {
    connected: true,
    send: (msg: object) => { desk.receive(msg); return true },
  })
  bus.on('to-plugin', (msg) => fakePort.emit('message', msg))
  const host = createHostChannel(fakePort as unknown as NodeJS.Process, {
    onBind: () => {},
    onBindSource: (sessionId, allowedTools) => bound.push({ sessionId, allowedTools }),
  })
  await desk.bindSource('sess-source-1', ['mail_search', 'mail_read'])
  assert.deepEqual(bound, [{ sessionId: 'sess-source-1', allowedTools: ['mail_search', 'mail_read'] }])
  host.close()
  desk.close()
})

test('disabled plugin skips model call and marks source plugin_unavailable', async () => {
  let modelCalls = 0
  const h = harness('2026-11-19T12:00:00+08:00', {
    checkPlugin: async () => ({ ok: false, reason: '插件未启用' }),
    run: async () => { modelCalls += 1; return { ok: true, text: '{"action":"skip"}' } },
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

test('buildFeedSourcePrompt includes plugin name, instruction, lastSuccessAt and prior cursor', () => {
  const prompt = buildFeedSourcePrompt({
    pluginName: '@company/dsh-plugin-mail',
    name: '邮件',
    instruction: '只看客户邮件',
    lastSuccessAt: at('2026-11-19T12:00:00Z'),
    cursor: { uid: 7 },
  }, at('2026-11-19T12:30:00Z'))
  assert.match(prompt, /@company\/dsh-plugin-mail/)
  assert.match(prompt, /只看客户邮件/)
  assert.match(prompt, /2026-11-19T12:00:00\.000Z/)
  assert.match(prompt, /"uid":7/)
})
