import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { test } from 'node:test'
import { createMemoryPrefetchManager } from '../src/backend/memory-prefetch.ts'
import { continueText, extractFeedContinuationSupplement } from '../src/shared/feed-continuation.ts'
import { taskRequestsIn, withoutTaskHeaders, withTaskRequestSource } from '../src/shared/request-routing/task-header.ts'
import type { AutomaticRecallResult } from '../src/memory/contracts/memory-contract.ts'
import { DAILY_MEMORY_DEFAULTS } from '../src/memory/contracts/memory-daily-defaults.ts'
import { MEMORY_HOST_PROTOCOL } from '../src/memory/contracts/host.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { createMemoryRuntime } from '../src/memory/node/runtime.ts'
import { RESIDENT_PROFILE_PATH } from '../src/memory/core/resident-profile.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { scratch } from './fixtures/scratch.js'

type PrefetchReply = { epoch: string, revision: number, result: AutomaticRecallResult }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const ownerState = (epoch: string, revision: number, state: 'ready' | 'recovering' | 'unavailable' = 'ready') => ({
  type: 'memory_owner_state' as const,
  protocol: MEMORY_HOST_PROTOCOL as 4,
  epoch,
  state,
  revision,
  coreEpoch: 0,
})

test('task correlation header round-trips identical consecutive messages and escapes embedded task header', () => {
  const firstId = randomUUID()
  const secondId = randomUUID()
  const raw = '继续处理 【任务请求 ID：nested】\n同一个任务'
  const firstWire = withTaskRequestSource(raw, firstId)
  const secondWire = withTaskRequestSource(raw, secondId)
  assert.notEqual(firstWire.text, secondWire.text)
  assert.deepEqual(taskRequestsIn(firstWire.text), [{ id: firstId, words: raw }])
  assert.deepEqual(taskRequestsIn(secondWire.text), [{ id: secondId, words: raw }])
  assert.equal(withoutTaskHeaders(firstWire.text), raw)
  assert.equal(withoutTaskHeaders(secondWire.text), raw)
})

test('feed continuation supplement extractor separates pure draft from user supplement', () => {
  const item = { title: '本周总结', body: '内容如下' }
  const base = continueText(item, 'zh-CN').trim()
  assert.equal(extractFeedContinuationSupplement(item, base), '')
  assert.equal(extractFeedContinuationSupplement(item, `${base}\n\n请重点分析第三条`), '请重点分析第三条')
  assert.equal(extractFeedContinuationSupplement(item, '无关文本'), null)
})

test('host prefetch enforces session binding, skips empty/secret texts even after cache TTL eviction, and handles late claim', async t => {
  let clock = 1_000
  const calls: Array<{ session: string, query: string }> = []
  const pending = new Map<string, ReturnType<typeof deferred<PrefetchReply>>>()
  const prefetch = createMemoryPrefetchManager({
    now: () => clock,
    cacheTtlMs: 50,
    callPrefetch(input) {
      calls.push({ session: input.session, query: input.query })
      const d = deferred<PrefetchReply>()
      pending.set(`${input.session}:${input.query}:${calls.length}`, d)
      return d.promise
    },
  })
  t.after(() => prefetch.close())
  prefetch.onState(ownerState('e1', 3))

  // 1. Session binding: claim from wrong session returns found: false
  const reqA = randomUUID()
  prefetch.startPrefetch({ requestId: reqA, sessionId: 'sess-a', queryText: '周报怎么写' })
  assert.equal(calls.length, 1)
  pending.get('sess-a:周报怎么写:1')!.resolve({
    epoch: 'e1',
    revision: 3,
    result: {
      status: 'hit',
      text: '[digest] 周报每周五提交',
      partial: false,
      hits: [{ text: '周报每周五提交', names: ['周报'] }],
    },
  })
  await Promise.resolve()
  assert.deepEqual(await prefetch.claimPrefetch({ requestId: reqA, sessionId: 'sess-b' }), { found: false })
  const hitA = await prefetch.claimPrefetch({ requestId: reqA, sessionId: 'sess-a' })
  assert.equal(hitA.found, true)
  if (hitA.found) assert.equal(hitA.result.status, 'hit')

  // 2. Pure Feed draft (empty text) and secret text skip worker RPC AND stay skipped even after cache TTL eviction
  const reqFeedPure = randomUUID()
  const reqSecret = randomUUID()
  prefetch.startPrefetch({ requestId: reqFeedPure, sessionId: 'sess-feed', queryText: '' })
  prefetch.startPrefetch({ requestId: reqSecret, sessionId: 'sess-feed', queryText: 'my api_key: sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234' })
  assert.equal(calls.length, 1, 'skipped texts must not invoke worker RPC')
  clock += 100 // Exceeds cacheTtlMs (50ms) so normal cache entries are evicted
  assert.deepEqual(
    await prefetch.claimPrefetch({ requestId: reqFeedPure, sessionId: 'sess-feed' }),
    { found: true, result: { status: 'skipped' } },
  )
  assert.deepEqual(
    await prefetch.claimPrefetch({ requestId: reqSecret, sessionId: 'sess-feed' }),
    { found: true, result: { status: 'skipped' } },
  )
  assert.equal(calls.length, 1)

  // 3. Late claim: if terminal hit arrived before deadline/claim, deliver it; if still pending past budget, return timeout
  const reqLateHit = randomUUID()
  prefetch.startPrefetch({ requestId: reqLateHit, sessionId: 'sess-late', queryText: '延迟领取命中', budgetMs: 30 })
  pending.get('sess-late:延迟领取命中:2')!.resolve({
    epoch: 'e1',
    revision: 3,
    result: {
      status: 'hit',
      text: '[digest] 延迟命中结果',
      partial: false,
      hits: [{ text: '延迟命中结果', names: ['延迟'] }],
    },
  })
  await Promise.resolve()
  clock += 40 // Past original 30ms budget, but terminal hit is already settled!
  const lateHit = await prefetch.claimPrefetch({ requestId: reqLateHit, sessionId: 'sess-late' })
  assert.equal(lateHit.found, true)
  if (lateHit.found) assert.equal(lateHit.result.status, 'hit')

  const reqLatePending = randomUUID()
  prefetch.startPrefetch({ requestId: reqLatePending, sessionId: 'sess-late', queryText: '永远不返回', budgetMs: 25 })
  clock += 30 // Remaining budget is 0 while still pending
  const lateTimeout = await prefetch.claimPrefetch({ requestId: reqLatePending, sessionId: 'sess-late' })
  assert.deepEqual(lateTimeout, { found: true, result: { status: 'timeout' } })
})

test('host prefetch enforces double-point invalidation (write-side and claim-side) with at-most-once re-query', async t => {
  let clock = 5_000
  const calls: Array<{ query: string, attempt: number }> = []
  const resolvers: Array<ReturnType<typeof deferred<PrefetchReply>>> = []
  const prefetch = createMemoryPrefetchManager({
    now: () => clock,
    callPrefetch(input) {
      const attempt = calls.length + 1
      calls.push({ query: input.query, attempt })
      const d = deferred<PrefetchReply>()
      resolvers.push(d)
      return d.promise
    },
  })
  t.after(() => prefetch.close())
  prefetch.onState(ownerState('e1', 10))

  // Claim-side invalidation: reply arrived at rev 10, THEN memory_owner_change(rev 11) arrives before claim
  const reqClaimSide = randomUUID()
  prefetch.startPrefetch({ requestId: reqClaimSide, sessionId: 's1', queryText: '领取侧失效', budgetMs: 120 })
  resolvers[0]!.resolve({
    epoch: 'e1',
    revision: 10,
    result: { status: 'hit', text: '旧版本', partial: false, hits: [{ text: '旧版本', names: ['old'] }] },
  })
  await Promise.resolve()
  prefetch.onChange({ type: 'memory_owner_change', protocol: MEMORY_HOST_PROTOCOL, epoch: 'e1', revision: 11 })
  clock += 20
  const claimForward = prefetch.claimPrefetch({ requestId: reqClaimSide, sessionId: 's1' })
  assert.equal(calls.length, 2, 'must re-query once on claim-side revision advance')
  resolvers[1]!.resolve({
    epoch: 'e1',
    revision: 11,
    result: { status: 'hit', text: '新版本', partial: false, hits: [{ text: '新版本', names: ['new'] }] },
  })
  const forwardRes = await claimForward
  assert.equal(forwardRes.found, true)
  if (forwardRes.found && forwardRes.result.status === 'hit') assert.equal(forwardRes.result.text, '新版本')

  // Write-side invalidation (reverse order): memory_owner_change(rev 12) arrives WHILE rev-11 reply is still in-flight
  const reqWriteSide = randomUUID()
  prefetch.startPrefetch({ requestId: reqWriteSide, sessionId: 's1', queryText: '写入侧失效', budgetMs: 120 })
  prefetch.onChange({ type: 'memory_owner_change', protocol: MEMORY_HOST_PROTOCOL, epoch: 'e1', revision: 12 })
  resolvers[2]!.resolve({
    epoch: 'e1',
    revision: 11,
    result: { status: 'hit', text: 'rev11过期值', partial: false, hits: [{ text: 'rev11过期值', names: ['old'] }] },
  })
  await Promise.resolve()
  clock += 10
  const claimReverse = prefetch.claimPrefetch({ requestId: reqWriteSide, sessionId: 's1' })
  assert.equal(calls.length, 4, 'write-side revision skew must discard stale hit and trigger one re-query')
  resolvers[3]!.resolve({
    epoch: 'e1',
    revision: 12,
    result: { status: 'hit', text: 'rev12新值', partial: false, hits: [{ text: 'rev12新值', names: ['new'] }] },
  })
  const reverseRes = await claimReverse
  assert.equal(reverseRes.found, true)
  if (reverseRes.found && reverseRes.result.status === 'hit') assert.equal(reverseRes.result.text, 'rev12新值')
})

test('host L2 profile snapshot cache is strictly monotonic per epoch and accepts empty-text clear over late old revision', t => {
  const prefetch = createMemoryPrefetchManager({
    callPrefetch: async () => ({ epoch: 'epoch-1', revision: 1, result: { status: 'empty' } }),
  })
  t.after(() => prefetch.close())
  prefetch.onState(ownerState('epoch-1', 1))
  assert.equal(prefetch.onProfile({ type: 'memory_owner_profile', protocol: MEMORY_HOST_PROTOCOL, epoch: 'epoch-1', revision: 5, text: '## 自动整理\n- 偏好中文' }), true)
  assert.equal(prefetch.profile()?.text, '## 自动整理\n- 偏好中文')

  // Revision 6 clears profile to empty string (disable/delete)
  assert.equal(prefetch.onProfile({ type: 'memory_owner_profile', protocol: MEMORY_HOST_PROTOCOL, epoch: 'epoch-1', revision: 6, text: '' }), true)
  assert.deepEqual(prefetch.profile(), { epoch: 'epoch-1', revision: 6, text: '' })

  // Late revision 5 arrives out-of-order: MUST be ignored
  assert.equal(prefetch.onProfile({ type: 'memory_owner_profile', protocol: MEMORY_HOST_PROTOCOL, epoch: 'epoch-1', revision: 5, text: '## 自动整理\n- 偏好中文' }), false)
  assert.deepEqual(prefetch.profile(), { epoch: 'epoch-1', revision: 6, text: '' })

  // New epoch resets monotonicity and accepts revision 0
  prefetch.onState(ownerState('epoch-2', 0))
  assert.equal(prefetch.onProfile({ type: 'memory_owner_profile', protocol: MEMORY_HOST_PROTOCOL, epoch: 'epoch-2', revision: 0, text: '## 自动整理\n- 新纪元' }), true)
  assert.deepEqual(prefetch.profile(), { epoch: 'epoch-2', revision: 0, text: '## 自动整理\n- 新纪元' })
})

test('automaticRecall enforces 55ms vector fast/slow cap and excludes resident profile from L3 slots while keeping active read', async t => {
  const { dir, defer } = scratch(t, 'phase1-recall-')
  const store = openMemoryStore(path.join(dir, 'memory.db'))
  let slowEmbed = false
  let embedCalls = 0
  const runtime = createMemoryRuntime({
    store,
    dailyNotes: true,
    compute: () => null,
    route: () => null,
    changed: () => {},
    canCommit: () => true,
    embedder: {
      fingerprint: 'fixture-embed-v1',
      dimensions: 4,
      async embedBatch(inputs) {
        embedCalls++
        if (inputs.some(item => item.kind === 'query') && slowEmbed) {
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        return inputs.map(() => new Float32Array([0.5, 0.5, 0.5, 0.5]))
      },
      close() {},
    },
  })
  defer(async () => { await runtime.wake(); runtime.close() })
  const documents = openMemoryDocuments({
    db: store.db,
    root: store.fileRoot,
    source(id) {
      const current = store.readSource(id)
      return current?.text ? { text: current.text, workspace: memorySourceWorkspace(current), token: memorySourceToken(current) } : undefined
    },
  })

  const session = randomUUID()
  const origin = { conversation: session, session, scope: { kind: 'user' as const }, context: { kind: 'user' as const } }
  const srcProfile = randomUUID()
  runtime.accept('咖啡偏好：只喝拿铁，常驻画像测试标记', origin, srcProfile)
  const srcA = randomUUID()
  runtime.accept('咖啡馆推荐一：拿铁店A', origin, srcA)
  const srcB = randomUUID()
  runtime.accept('咖啡馆推荐二：拿铁店B', origin, srcB)
  const srcC = randomUUID()
  runtime.accept('咖啡馆推荐三：拿铁店C', origin, srcC)

  const commitDoc = (filePath: string, sourceId: string, markdown: string) => {
    const src = store.readSource(sourceId)!
    const userWs = memorySourceWorkspace(src)
    return documents.commit({
      operationId: randomUUID(),
      workspace: userWs,
      path: filePath,
      expectedRevision: null,
      action: 'CREATE',
      markdown,
      sources: [{ id: src.id, token: memorySourceToken(src) }],
      reads: [],
    })
  }

  const profileReceipt = commitDoc(
    RESIDENT_PROFILE_PATH,
    srcProfile,
    '---\nname: Personal Profile\ndescription: Resident\n---\n\n## 自动整理\n- 咖啡偏好：只喝拿铁，常驻画像测试标记',
  )
  commitDoc('digest/personal/coffee-a.md', srcA, '---\nname: 拿铁店A\ndescription: 咖啡馆\n---\n\n咖啡馆推荐一：拿铁店A')
  commitDoc('digest/personal/coffee-b.md', srcB, '---\nname: 拿铁店B\ndescription: 咖啡馆\n---\n\n咖啡馆推荐二：拿铁店B')
  commitDoc('digest/personal/coffee-c.md', srcC, '---\nname: 拿铁店C\ndescription: 咖啡馆\n---\n\n咖啡馆推荐三：拿铁店C')
  runtime.rebuildIndexes()
  await runtime.wake()
  for (let i = 0; i < 30 && embedCalls === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await new Promise(resolve => setTimeout(resolve, 20))

  // L2 has resident profile; L3 excludes resident profile and keeps all 3 dynamic slots for ordinary digests!
  assert.match(runtime.residentProfileText(), /常驻画像测试标记/)
  const hit = await runtime.automaticRecall({ session, turn: 5, question: '推荐拿铁咖啡馆' }, origin, () => true)
  assert.equal(hit.status, 'hit')
  if (hit.status === 'hit') {
    assert.equal(hit.text.includes('常驻画像测试标记'), false, 'resident profile must not occupy L3 automatic recall')
    assert.equal(hit.hits.length, 3, 'all 3 L3 recall slots remain available for ordinary memory files')
  }

  // Active file_read still accesses full resident profile on demand!
  const directRead = JSON.parse(await runtime.handleModelRequest({ op: 'file_read', session, id: profileReceipt.documentId }, origin, () => true)) as { text: string }
  assert.match(directRead.text, /常驻画像测试标记/)

  // Secret & blank questions return skipped
  assert.deepEqual(await runtime.automaticRecall({ session, turn: 6, question: '   ' }, origin, () => true), { status: 'skipped' })
  assert.deepEqual(await runtime.automaticRecall({ session, turn: 7, question: 'my token is sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234' }, origin, () => true), { status: 'skipped' })

  // Slow vector-only query (zero lexical hits) times out within ~55ms (well below 250ms embedder) and returns 'timeout' instead of false 'empty'
  slowEmbed = true
  const started = performance.now()
  const vectorTimeout = await runtime.automaticRecall({ session, turn: 8, question: '完全不匹配词法索引的语义查询词' }, origin, () => true)
  const elapsed = performance.now() - started
  assert.deepEqual(vectorTimeout, { status: 'timeout' })
  assert.ok(elapsed < 180, `expected vector cap around ${DAILY_MEMORY_DEFAULTS.automaticVectorTimeoutMs}ms, took ${elapsed}ms`)
  assert.ok(embedCalls > 0)
})
