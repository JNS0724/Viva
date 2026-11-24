import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { EventEmitter } from 'node:events'
import { openFeedStore, type FeedItem } from '../src/backend/feed-store.ts'
import { openFeedSourceStore } from '../src/backend/feed-source-store.ts'
import {
  buildFeedSourcePrompt, createFeedSourceRuns, MAX_ATTEMPTS, MAX_ITEMS_PER_RUN,
  parseFeedSourceOutput, RETRY_MS, type PluginCheckResult, type SourceExecutionPolicy,
} from '../src/backend/feed-source-runs.ts'
import { declaredReadOnlyTools } from '../src/backend/plugin-fit.ts'
import { createRoutingDesk } from '../src/backend/routing-channel.ts'
import { createHostChannel } from '../plugins/routing/lib/host.ts'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createSourceGuard, verifyPluginReadOnlyTools } from '../plugins/routing/lib/source-tools.ts'
import type { RunResult } from '../src/backend/unattended-runs.ts'

const at = (iso: string) => Date.parse(iso)
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function harness(start: string, { checkPlugin, run, serialize }: {
  checkPlugin?: (name: string) => Promise<PluginCheckResult>
  run: (prompt: string, cwd: string, policy: SourceExecutionPolicy) => Promise<RunResult>
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
    checkPlugin: checkPlugin ?? (async () => ({ ok: true, ownerEntryIds: ['entry-mail'], allowedTools: ['mail_search', 'mail_read'] })),
    run,
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

test('parseFeedSourceOutput accepts publish/skip, caps items, and rejects prose, unknown actions, and malformed publish payloads', () => {
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

  assert.equal(parseFeedSourceOutput('插件暂时无法读取，请稍后重试', '邮件监控').kind, 'invalid')
  assert.equal(parseFeedSourceOutput('{"action":"error","message":"timeout"}', '邮件监控').kind, 'invalid')
  // Malformed publish with empty body must return invalid so it does not consume a new cursor
  assert.equal(parseFeedSourceOutput('{"action":"publish","items":[{"title":"空正文","body":"   "}],"cursor":{"uid":99}}', '邮件监控').kind, 'invalid')
  assert.equal(parseFeedSourceOutput('{"action":"publish","items":[],"cursor":{"uid":99}}', '邮件监控').kind, 'invalid')
})

test('invalid or malformed publish output never publishes, preserves cursor, and retries as failure', async () => {
  let calls = 0
  const h = harness('2026-11-19T12:00:00+08:00', {
    run: async () => {
      calls += 1
      return { ok: true, text: '{"action":"publish","items":[{"title":"空","body":""}],"cursor":{"uid":99}}' }
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
  assert.deepEqual(h.store.get(source.id)?.cursor, { uid: 9 }, 'cursor preserved across malformed publish')
  assert.equal(h.store.get(source.id)?.lastSuccessAt, at('2026-11-19T12:00:00+08:00'))
})

test('without cursor, incremental checkpoint uses query start time rather than completion time', async () => {
  const prompts: string[] = []
  const h = harness('2026-11-19T08:30:00+08:00', {
    run: async (prompt) => {
      prompts.push(prompt)
      // Simulate a 6-minute run finishing at 09:06 when started at 09:00
      h.setNow('2026-11-19T09:06:00+08:00')
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

  await h.advance('2026-11-19T09:00:00+08:00')
  const afterFirst = h.store.get(source.id)!
  assert.equal(afterFirst.lastRunAt, at('2026-11-19T09:06:00+08:00'), 'display time is completion time')
  assert.equal(afterFirst.lastSuccessAt, at('2026-11-19T09:00:00+08:00'), 'incremental checkpoint is query start time')

  await h.advance('2026-11-19T09:30:00+08:00')
  assert.match(prompts[1], /2026-11-19T01:00:00\.000Z/, 'next prompt starts from 09:00+08:00, not 09:06+08:00')
})


test('serializer covers through commit so manual runNow cannot race a delayed run and regress cursor', async () => {
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn)
    queue = next.then(() => undefined, () => undefined)
    return next
  }
  let releaseRun!: () => void
  let runIndex = 0
  const prompts: string[] = []

  const h = harness('2026-11-19T12:00:00+08:00', {
    serialize,
    run: async (prompt) => {
      prompts.push(prompt)
      runIndex += 1
      if (runIndex === 1) await new Promise<void>(resolve => { releaseRun = resolve })
      return {
        ok: true,
        text: JSON.stringify({
          action: 'publish',
          items: [{ key: `k-${runIndex}`, title: `条目 ${runIndex}`, body: '正文' }],
          cursor: runIndex,
        }),
      }
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
  const manualPromise = h.runs.runNow(source.id)
  await flush()
  assert.equal(runIndex, 1, 'manual run must wait until scheduled run finishes commit')

  releaseRun()
  await manualPromise
  assert.equal(runIndex, 2)
  assert.match(prompts[1], /上次保存的增量游标：1/, 'manual run sees cursor 1 committed by scheduled run')
  assert.equal(h.store.get(source.id)?.cursor, 2, 'cursor advances monotonically 1 -> 2 without regression')
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
  h.store.setPaused(source.id, true)
  releaseBlocker()
  await flush()
  await flush()

  assert.equal(runCalls, 0, 'paused source must not start a session once serializer releases')
})

test('bindings require read-only tools from the selected loader entry and recheck replacements', async (t) => {
  assert.deepEqual(
    declaredReadOnlyTools({
      viva: { feedSource: { readOnlyTools: ['mail_search', 'bash', 'write', 'memory_remember', 'mail_read', 'mail_search'] } },
    }),
    ['mail_search', 'mail_read'],
  )

  const tool = (name: string, readOnly: boolean): ToolDefinition => ({
    ...defineTool({
      name,
      description: 'Returns a fixture value.',
      parameters: {},
      output: { schema: { type: 'string' }, render: () => [] },
      execute: async () => 'fixture',
    }),
    annotations: { readOnlyHint: readOnly },
  } as ToolDefinition)
  const search = tool('mail_search', true)
  const writer = tool('mail_send', false)
  const foreign = tool('other_read', true)
  const tools = new Map([search, writer, foreign].map(definition => [definition.name, definition]))
  const owners = new Map([
    [search, new Set(['entry-mail'])],
    [writer, new Set(['entry-mail'])],
    [foreign, new Set(['entry-other'])],
  ])
  const policy = { pluginName: '@company/dsh-plugin-mail', ownerEntryIds: ['entry-mail'], allowedTools: [search.name] }
  const verify = (allowedTools: string[]) => verifyPluginReadOnlyTools(
    { ...policy, allowedTools }, name => tools.get(name), definition => owners.get(definition),
  )
  assert.deepEqual(verify([search.name]), { ok: true })
  assert.equal(verify([foreign.name]).ok, false)
  assert.equal(verify([writer.name]).ok, false)

  let receive: (message: unknown) => void = () => {}
  const desk = createRoutingDesk({
    send: message => receive(message),
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
    send: (message: object) => { desk.receive(message); return true },
  })
  receive = message => { fakePort.emit('message', message) }
  const host = createHostChannel(fakePort as unknown as NodeJS.Process, {
    onBind: () => {},
    onBindSource: ({ pluginName, ownerEntryIds, allowedTools }) => verifyPluginReadOnlyTools(
      { pluginName, ownerEntryIds, allowedTools }, name => tools.get(name), definition => owners.get(definition),
    ),
  })
  t.after(() => { host.close(); desk.close() })
  await desk.bindSource('sess-ok', policy)
  await assert.rejects(() => desk.bindSource('sess-foreign', { ...policy, allowedTools: [foreign.name] }), /归属其他插件/)

  const guard = createSourceGuard(definition => owners.get(definition))
  guard.bind('sess-ok', policy)
  assert.equal(guard.deny('sess-ok', search.name, search), undefined)
  assert.match(guard.deny('sess-ok', writer.name, writer) ?? '', /拒绝/)
  const replacement = tool(search.name, true)
  owners.set(replacement, new Set(['entry-other']))
  assert.match(guard.deny('sess-ok', search.name, replacement) ?? '', /归属其他插件/)
  owners.set(replacement, new Set(['entry-mail']))
  assert.equal(guard.deny('sess-ok', search.name, replacement), undefined)
  const changedCapability = tool(search.name, false)
  owners.set(changedCapability, new Set(['entry-mail']))
  assert.match(guard.deny('sess-ok', search.name, changedCapability) ?? '', /只读/)
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
