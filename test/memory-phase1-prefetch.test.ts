import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { createMemoryPrefetchManager } from '../src/backend/memory-prefetch.ts'
import { continueText, extractFeedContinuationSupplement } from '../src/shared/feed-continuation.ts'
import { requestsIn } from '../src/shared/request-routing/header.ts'
import { leadingTaskRequestId, taskRequestsIn, withoutTaskHeaders, withTaskRequestSource } from '../src/shared/request-routing/task-header.ts'
import { openPluginOwner } from '../plugins/memory/lib/standalone-owner.ts'
import { applyMemoryAdapter } from '../plugins/memory/lib/adapter.ts'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { writeFileSync } from 'node:fs'
import { withRequestSource } from '../src/shared/request-routing/header.ts'
import { MEMORY_OWNER_RPC, ownerRpcFrame } from '../src/memory/contracts/owner-rpc.ts'
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

test('task header escapes quoted main-conversation routing headers and preserves exact spans (P2-4)', () => {
  const outerId = 'real-task-123'
  const raw = '分析日志：\n【请求 ID：quoted-main】\n用户原话：被引用内容'
  const wrapped = withTaskRequestSource(raw, outerId)
  assert.equal(leadingTaskRequestId(wrapped.text), outerId)
  assert.deepEqual(requestsIn(wrapped.text), [], 'quoted main routing header inside task body must not match requestsIn')
  assert.equal(withoutTaskHeaders(wrapped.text), raw)
  const reconstructed = wrapped.spans.map(span => wrapped.text.slice(span.start, span.end)).join('')
  assert.equal(reconstructed, raw)
})

test('claimPrefetchBatch rejects stale hit A when file is disabled while sibling B is still pending (P1-3)', async t => {
  let clock = 5_000
  const pending = new Map<string, ReturnType<typeof deferred<PrefetchReply>>>()
  let calls = 0
  const prefetch = createMemoryPrefetchManager({
    now: () => clock,
    defaultBudgetMs: 100,
    callPrefetch(input) {
      calls++
      const d = deferred<PrefetchReply>()
      pending.set(`${input.query}:${calls}`, d)
      return d.promise
    },
  })
  t.after(() => prefetch.close())
  prefetch.onState(ownerState('e1', 10))

  const reqA = randomUUID()
  const reqB = randomUUID()
  prefetch.startPrefetch({ requestId: reqA, sessionId: 'sess-steer', queryText: 'query-A' })
  prefetch.startPrefetch({ requestId: reqB, sessionId: 'sess-steer', queryText: 'query-B' })

  // A completes at revision 10 first; B is still pending.
  pending.get('query-A:1')!.resolve({
    epoch: 'e1',
    revision: 10,
    result: { status: 'hit', text: 'A_SECRET_DISABLED', partial: false, hits: [{ text: 'A_SECRET_DISABLED', names: ['a'] }] },
  })
  await Promise.resolve()

  const batchPromise = prefetch.claimPrefetchBatch({ sessionId: 'sess-steer', requestIds: [reqA, reqB] })
  await Promise.resolve()

  // While B is waiting, user disables A's file -> revision advances to 11 and budget expires.
  clock += 110
  prefetch.onChange({ type: 'memory_owner_change', protocol: MEMORY_HOST_PROTOCOL, epoch: 'e1', revision: 11 })
  pending.get('query-B:2')!.resolve({ epoch: 'e1', revision: 11, result: { status: 'empty' } })

  const results = await batchPromise
  assert.equal(results.length, 2)
  assert.equal(results[0]!.found, true)
  if (results[0]!.found) assert.equal(results[0]!.result.status, 'timeout', 'disabled hit A must not survive sibling wait')
  assert.equal(results[1]!.found, true)
  if (results[1]!.found) assert.equal(results[1]!.result.status, 'timeout', 'late B reply past absolute deadline must timeout')
})

test('prefetch preserves timeout and skipped markers across TTL and >1000 deliveries and enforces absolute deadline on replies (P2-1, P2-2)', async t => {
  let clock = 10_000
  const pending = new Map<string, ReturnType<typeof deferred<PrefetchReply>>>()
  let calls = 0
  const prefetch = createMemoryPrefetchManager({
    now: () => clock,
    defaultBudgetMs: 80,
    cacheTtlMs: 50,
    callPrefetch(input) {
      calls++
      const d = deferred<PrefetchReply>()
      pending.set(`${input.query}:${calls}`, d)
      return d.promise
    },
  })
  t.after(() => prefetch.close())
  prefetch.onState(ownerState('e1', 1))

  // 1. Reply arriving after absolute deadlineAt (even before setTimeout callback) MUST become timeout.
  const reqLateReply = randomUUID()
  prefetch.startPrefetch({ requestId: reqLateReply, sessionId: 's1', queryText: 'late-reply' })
  clock += 85 // past deadlineAt (10_080) without waiting for real setTimeout
  pending.get('late-reply:1')!.resolve({
    epoch: 'e1', revision: 1,
    result: { status: 'hit', text: 'SHOULD_NOT_HIT', partial: false, hits: [{ text: 'SHOULD_NOT_HIT', names: ['x'] }] },
  })
  await Promise.resolve()
  // Also advance past cacheTtlMs (50ms) and trigger cleanupExpired via another prefetch.
  clock += 200
  const reqFirstSkipped = randomUUID()
  prefetch.startPrefetch({ requestId: reqFirstSkipped, sessionId: 's1', queryText: '' })
  // Push >1005 skipped entries to prove earlier skipped delivery is NOT evicted by an arbitrary 1000 cap.
  for (let i = 0; i < 1005; i++) {
    prefetch.startPrefetch({ requestId: `skip-${i}`, sessionId: 's-other', queryText: 'my token is sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234' })
  }
  assert.equal(calls, 1, 'skipped entries must not call worker')

  const lateClaim = await prefetch.claimPrefetch({ requestId: reqLateReply, sessionId: 's1' })
  assert.equal(lateClaim.found, true)
  if (lateClaim.found) assert.equal(lateClaim.result.status, 'timeout', 'settled timeout must survive TTL eviction')

  const skippedClaim = await prefetch.claimPrefetch({ requestId: reqFirstSkipped, sessionId: 's1' })
  assert.equal(skippedClaim.found, true)
  if (skippedClaim.found) assert.equal(skippedClaim.result.status, 'skipped', 'skipped delivery must survive TTL and >1000 sibling deliveries')

  // 2. Re-query reply arriving after absolute deadlineAt MUST also become timeout.
  const reqRequery = randomUUID()
  prefetch.startPrefetch({ requestId: reqRequery, sessionId: 's2', queryText: 'requery-late' })
  pending.get('requery-late:2')!.resolve({
    epoch: 'e1', revision: 1,
    result: { status: 'hit', text: 'OLD', partial: false, hits: [{ text: 'OLD', names: ['old'] }] },
  })
  await Promise.resolve()
  prefetch.onChange({ type: 'memory_owner_change', protocol: MEMORY_HOST_PROTOCOL, epoch: 'e1', revision: 2 })
  clock += 40 // 40ms remaining -> triggers requery
  const requeryClaimPromise = prefetch.claimPrefetch({ requestId: reqRequery, sessionId: 's2' })
  await Promise.resolve()
  clock += 50 // now past deadlineAt before requery resolves
  pending.get('requery-late:3')!.resolve({
    epoch: 'e1', revision: 2,
    result: { status: 'hit', text: 'LATE_REQUERY', partial: false, hits: [{ text: 'LATE_REQUERY', names: ['late'] }] },
  })
  const requeryClaim = await requeryClaimPromise
  assert.equal(requeryClaim.found, true)
  if (requeryClaim.found) assert.equal(requeryClaim.result.status, 'timeout')
})

test('late old-epoch attach response does not overwrite newer epoch L2 profile snapshot (P2-3)', async t => {
  const port = Object.assign(new EventEmitter(), {
    connected: true,
    sent: [] as Array<Record<string, unknown>>,
    send(frame: Record<string, unknown>, cb?: () => void) {
      this.sent.push(frame)
      cb?.()
      return true
    },
  })
  const conn = openPluginOwner({ root: '/tmp/viva-p2-3-test', hostNamespace: 'viva' }, port as unknown as typeof process)
  t.after(() => conn.close())

  const seenProfiles: Array<{ epoch: string, revision: number, text: string }> = []
  conn.subscribe(raw => {
    if (raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'memory_owner_profile') {
      const p = raw as { epoch: string, revision: number, text: string }
      seenProfiles.push({ epoch: p.epoch, revision: p.revision, text: p.text })
    }
  })

  const startPromise = conn.start()
  await new Promise(resolve => setImmediate(resolve))
  const attachReq = port.sent.find(frame => frame.kind === 'request' && frame.method === 'attach')
  assert.ok(attachReq && typeof attachReq.id === 'string')

  // Newer epoch-2 state + profile arrive BEFORE the delayed attach response from epoch-1.
  port.emit('message', { type: 'memory_owner_rpc', kind: 'event', event: ownerState('epoch-2', 4) })
  port.emit('message', {
    type: 'memory_owner_rpc', kind: 'event',
    event: { type: 'memory_owner_profile', protocol: MEMORY_HOST_PROTOCOL, epoch: 'epoch-2', revision: 4, text: '## 自动整理\n- 新纪元画像' },
  })
  // Delayed attach response carrying stale epoch-1 state & profile arrives now.
  port.emit('message', {
    type: 'memory_owner_rpc', kind: 'result', id: attachReq.id, ok: true,
    result: {
      state: ownerState('epoch-1', 1),
      profile: { epoch: 'epoch-1', revision: 1, text: '## 自动整理\n- 过期旧纪元画像' },
    },
  })
  await startPromise

  assert.deepEqual(seenProfiles, [{ epoch: 'epoch-2', revision: 4, text: '## 自动整理\n- 新纪元画像' }])
  // Late subscriber must still receive the epoch-2 profile, not epoch-1!
  const lateSubscriberProfiles: Array<{ epoch: string, text: string }> = []
  conn.subscribe(raw => {
    if (raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'memory_owner_profile') {
      const p = raw as { epoch: string, text: string }
      lateSubscriberProfiles.push({ epoch: p.epoch, text: p.text })
    }
  })
  assert.deepEqual(lateSubscriberProfiles, [{ epoch: 'epoch-2', text: '## 自动整理\n- 新纪元画像' }])
})

test('TTL eviction retains empty and stale-hit delivery terminals and cancelPrefetch/clearSession release them (R2 P2-2, P2-3)', async t => {
  let clock = 20_000
  const pending = new Map<string, ReturnType<typeof deferred<PrefetchReply>>>()
  let calls = 0
  const prefetch = createMemoryPrefetchManager({
    now: () => clock,
    defaultBudgetMs: 80,
    cacheTtlMs: 50,
    callPrefetch(input) {
      calls++
      const d = deferred<PrefetchReply>()
      pending.set(`${input.query}:${calls}`, d)
      return d.promise
    },
  })
  t.after(() => prefetch.close())
  prefetch.onState(ownerState('e1', 5))

  // 1. Settled empty survives TTL without falling back to found:false
  const reqEmpty = randomUUID()
  prefetch.startPrefetch({ requestId: reqEmpty, sessionId: 's-ttl', queryText: 'no-match' })
  pending.get('no-match:1')!.resolve({ epoch: 'e1', revision: 5, result: { status: 'empty' } })
  await Promise.resolve()

  // 2. Settled hit invalidated by R+1 survives TTL as timeout without falling back to found:false
  const reqStaleHit = randomUUID()
  prefetch.startPrefetch({ requestId: reqStaleHit, sessionId: 's-ttl', queryText: 'will-stale' })
  pending.get('will-stale:2')!.resolve({
    epoch: 'e1', revision: 5,
    result: { status: 'hit', text: 'STALE', partial: false, hits: [{ text: 'STALE', names: ['s'] }] },
  })
  await Promise.resolve()
  prefetch.onChange({ type: 'memory_owner_change', protocol: MEMORY_HOST_PROTOCOL, epoch: 'e1', revision: 6 })

  // 3. Undelivered skipped delivery can be cancelled cleanly; closed session releases its terminals
  const reqCancelled = randomUUID()
  const reqOtherSession = randomUUID()
  prefetch.startPrefetch({ requestId: reqCancelled, sessionId: 's-ttl', queryText: '' })
  prefetch.startPrefetch({ requestId: reqOtherSession, sessionId: 's-keep', queryText: '' })

  clock += 200
  prefetch.cleanupExpired()

  prefetch.cancelPrefetch('s-ttl', reqCancelled)
  assert.deepEqual(await prefetch.claimPrefetch({ requestId: reqCancelled, sessionId: 's-ttl' }), { found: false })

  const emptyClaim = await prefetch.claimPrefetch({ requestId: reqEmpty, sessionId: 's-ttl' })
  assert.deepEqual(emptyClaim, { found: true, result: { status: 'empty' } })

  const staleClaim = await prefetch.claimPrefetch({ requestId: reqStaleHit, sessionId: 's-ttl' })
  assert.deepEqual(staleClaim, { found: true, result: { status: 'timeout' } })
  assert.equal(calls, 2, 'no second retrieval may run after TTL eviction of empty or stale hit')

  // clearSession cleans target session only
  const reqCloseMe = randomUUID()
  prefetch.startPrefetch({ requestId: reqCloseMe, sessionId: 's-ttl', queryText: '' })
  prefetch.clearSession('s-ttl')
  assert.deepEqual(await prefetch.claimPrefetch({ requestId: reqCloseMe, sessionId: 's-ttl' }), { found: false })
  assert.deepEqual(await prefetch.claimPrefetch({ requestId: reqOtherSession, sessionId: 's-keep' }), { found: true, result: { status: 'skipped' } })
})

test('valid on-time hit survives >60s TTL cleanup when owner epoch and revision are unchanged (R3 P2-2)', async t => {
  let clock = 50_000
  const reply = deferred<PrefetchReply>()
  const prefetch = createMemoryPrefetchManager({
    now: () => clock,
    defaultBudgetMs: 80,
    cacheTtlMs: 60_000,
    callPrefetch: () => reply.promise,
  })
  t.after(() => prefetch.close())
  prefetch.onState(ownerState('e-valid', 9))

  const reqValid = randomUUID()
  prefetch.startPrefetch({ requestId: reqValid, sessionId: 's-late-hit', queryText: 'valid query' })
  reply.resolve({
    epoch: 'e-valid', revision: 9,
    result: { status: 'hit', text: 'VALID_LATE_EVIDENCE', partial: false, hits: [{ text: 'VALID_LATE_EVIDENCE', names: ['note'] }] },
  })
  await Promise.resolve()

  // Advance clock past 60s TTL (61s) with epoch and revision unchanged, then run cleanupExpired
  clock += 61_000
  prefetch.cleanupExpired()

  const claim = await prefetch.claimPrefetch({ requestId: reqValid, sessionId: 's-late-hit' })
  assert.equal(claim.found, true)
  assert.equal(claim.result.status, 'hit', 'valid hit with unchanged epoch and revision must survive >60s TTL until delivered')
  if (claim.result.status === 'hit') assert.equal(claim.result.text, 'VALID_LATE_EVIDENCE')
})

test('multi-steer starts live fallback immediately for missing-ID sibling while slow sibling claim is pending, and pre-commit cancel/prepareRequest failure emit zero receipts (R3 P2-4, P2-7)', async t => {
  const { dir } = scratch(t, 'memory-r3-adapter-concurrency-')
  const root = path.join(dir, 'memory')
  const port = new EventEmitter() as EventEmitter & { connected: boolean, send: (frame: unknown, cb?: () => void) => boolean }
  port.connected = true

  const slowClaimA = deferred<{ found: boolean, result?: AutomaticRecallResult, epoch?: string, revision?: number }>()
  const fallbackEvents: string[] = []
  const contextUsedReports: unknown[] = []
  let slowAStarted = false
  let fallbackBStartedBeforeASettled = false

  port.send = (raw, cb) => {
    cb?.()
    const frame = ownerRpcFrame(raw)
    if (!frame || frame.kind !== 'request') return true
    if (frame.method === 'attach') {
      queueMicrotask(() => {
        port.emit('message', {
          type: MEMORY_OWNER_RPC, kind: 'result', id: frame.id, ok: true,
          result: { state: ownerState('e-conc', 1) },
        })
      })
      return true
    }
    if (frame.method === 'claimPrefetch') {
      const input = frame.input as { requestId: string, sessionId: string }
      if (input.requestId === reqA) {
        slowAStarted = true
        void slowClaimA.promise.then(res => {
          port.emit('message', { type: MEMORY_OWNER_RPC, kind: 'result', id: frame.id, ok: true, result: res })
        })
      } else {
        // Message B HAS an ID, but host has no prefetch entry -> immediate { found: false }
        queueMicrotask(() => {
          port.emit('message', { type: MEMORY_OWNER_RPC, kind: 'result', id: frame.id, ok: true, result: { found: false } })
        })
      }
      return true
    }
    if (frame.method === 'adapter') {
      const { method, args } = frame.input as { method: string, args: unknown[] }
      if (method === 'automaticRecall') {
        fallbackEvents.push('automaticRecall')
        if (slowAStarted && !aSettled) fallbackBStartedBeforeASettled = true
        queueMicrotask(() => {
          port.emit('message', {
            type: MEMORY_OWNER_RPC, kind: 'result', id: frame.id, ok: true,
            result: { status: 'hit', text: 'EVIDENCE_B', partial: false, hits: [{ text: 'EVIDENCE_B', names: ['b'] }] },
          })
        })
        return true
      }
      if (method === 'reportContextUsed') {
        contextUsedReports.push(args[0])
        queueMicrotask(() => {
          port.emit('message', { type: MEMORY_OWNER_RPC, kind: 'result', id: frame.id, ok: true, result: undefined })
        })
        return true
      }
      queueMicrotask(() => {
        port.emit('message', { type: MEMORY_OWNER_RPC, kind: 'result', id: frame.id, ok: true, result: { nextSeq: 0, createdAt: 0 } })
      })
    }
    return true
  }

  const reqA = randomUUID()
  const reqB = randomUUID()
  let aSettled = false

  const ctx = new Context()
  const preStepHandlers: Array<(payload: any, next: () => Promise<any>) => Promise<any>> = []
  const sessionEventHandlers: Array<(session: any, event: any) => void> = []
  const fakeCtx = Object.assign(ctx, {
    agents: { list: () => [] },
    sessions: { list: () => [], flush: async () => true, get: () => undefined },
    tools: { register: () => () => {} },
    llm: { stream: async function* () {} },
    on(event: string, listener: (...args: any[]) => any) {
      if (event === 'agent/pre-step') preStepHandlers.push(listener)
      if (event === 'session/event') sessionEventHandlers.push(listener)
      return () => {}
    },
    inject() { return () => {} },
    effect() { return () => {} },
  })

  const owner = applyMemoryAdapter(fakeCtx as unknown as Context, { host: true, dataRoot: root }, port as unknown as NodeJS.Process)
  t.after(async () => { await owner.close() })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(owner.ready(), true)

  const msgA = createUserMessage({ content: [{ type: 'text', text: withRequestSource('问题 A', reqA, '问题 A').text }], source: { kind: 'user' } })
  const msgB = createUserMessage({ content: [{ type: 'text', text: withRequestSource('问题 B', reqB, '问题 B').text }], source: { kind: 'user' } })
  const fakeSession = { id: 'sess-conc', header: { cwd: dir }, seq: 0, inheritedEventCount: 0, snapshotEvents: () => [] }
  const preStep = preStepHandlers[0]!

  const decisionPromise = preStep({
    agent: { session: fakeSession },
    turn: 1,
    signal: new AbortController().signal,
    modelSelection: { provider: 'test', model: 'm' },
  }, async () => ({ kind: 'enter', messages: [msgA, msgB] }))

  // Wait briefly for B's immediate { found: false } -> automaticRecall BEFORE resolving slow A!
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(fallbackBStartedBeforeASettled, true, 'message B with missing host claim must start fallback BEFORE slow sibling A settles')

  aSettled = true
  slowClaimA.resolve({
    found: true, epoch: 'e-conc', revision: 1,
    result: { status: 'hit', text: 'EVIDENCE_A', partial: false, hits: [{ text: 'EVIDENCE_A', names: ['a'] }] },
  })
  const decision = await decisionPromise
  const appendedRecall = decision.messages.slice(2)
  assert.equal(appendedRecall.length, 2)
  assert.match(appendedRecall[0].content[0].text, new RegExp(`ref="${reqA}"`))
  assert.match(appendedRecall[0].content[0].text, /EVIDENCE_A/)
  assert.match(appendedRecall[1].content[0].text, new RegExp(`ref="${reqB}"`))
  assert.match(appendedRecall[1].content[0].text, /EVIDENCE_B/)

  // Post-pre-step, pre-commit boundary: ZERO reportContextUsed before user/message is committed!
  assert.equal(contextUsedReports.length, 0, 'pre-step alone must NOT emit reportContextUsed before user/message commit')
  // Simulate post-pre-step cancellation / prepareRequest failure -> turn/end fires without user/message commit!
  for (const fn of sessionEventHandlers) fn(fakeSession, { type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'aborted' } } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(contextUsedReports.length, 0, 'post-pre-step cancellation before commit must emit 0 reportContextUsed')
  // Even a late stray event for the cleared recall message must not fire after turn/end cleanup
  for (const fn of sessionEventHandlers) fn(fakeSession, { type: 'user/message', seq: 2, time: Date.now(), data: appendedRecall[0] })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(contextUsedReports.length, 0, 'cleared pending confirmation must not fire after turn/end')

  // Simulate prepareRequest failure on turn 2: pre-step succeeds, turn/end(error) fires without commit -> 0 reports
  const decision2 = await preStep({
    agent: { session: fakeSession },
    turn: 2,
    signal: new AbortController().signal,
    modelSelection: { provider: 'test', model: 'm' },
  }, async () => ({ kind: 'enter', messages: [msgB] }))
  assert.equal(decision2.messages.length, 2)
  for (const fn of sessionEventHandlers) fn(fakeSession, { type: 'turn/end', seq: 3, time: Date.now(), data: { turn: 2, reason: { kind: 'error' } } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(contextUsedReports.length, 0, 'prepareRequest failure before commit must emit 0 reportContextUsed')

  // Committed turn 3: emitting user/message confirms reportContextUsed exactly once (and continuation step has no human message -> still 1!)
  const decision3 = await preStep({
    agent: { session: fakeSession },
    turn: 3,
    signal: new AbortController().signal,
    modelSelection: { provider: 'test', model: 'm' },
  }, async () => ({ kind: 'enter', messages: [msgB] }))
  for (const fn of sessionEventHandlers) fn(fakeSession, { type: 'user/message', seq: 4, time: Date.now(), data: decision3.messages[1] })
  // Continuation step with empty human messages
  await preStep({
    agent: { session: fakeSession },
    turn: 3,
    signal: new AbortController().signal,
    modelSelection: { provider: 'test', model: 'm' },
  }, async () => ({ kind: 'enter', messages: [] }))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(contextUsedReports.length, 1, 'committed turn with continuation step must emit reportContextUsed exactly once')
})

test('multi-steer refreshes hit A once within its original deadline if revision changes while sibling B is pending (R4 P2-4)', async t => {
  const { dir } = scratch(t, 'memory-r4-adapter-refresh-')
  const root = path.join(dir, 'memory')
  const port = new EventEmitter() as EventEmitter & { connected: boolean, send: (frame: unknown, cb?: () => void) => boolean }
  port.connected = true

  const reqA = randomUUID()
  const reqB = randomUUID()
  const slowClaimB = deferred<{ found: boolean, result?: AutomaticRecallResult, epoch?: string, revision?: number }>()
  let refreshCount = 0

  port.send = (raw, cb) => {
    cb?.()
    const frame = ownerRpcFrame(raw)
    if (!frame || frame.kind !== 'request') return true
    if (frame.method === 'attach') {
      queueMicrotask(() => {
        port.emit('message', {
          type: MEMORY_OWNER_RPC, kind: 'result', id: frame.id, ok: true,
          result: { state: ownerState('e-ref', 1) },
        })
      })
      return true
    }
    if (frame.method === 'claimPrefetch') {
      const input = frame.input as { requestId: string, sessionId: string }
      if (input.requestId === reqA) {
        // Hit A arrives immediately at revision 1 with 115ms remaining on its original deadline
        queueMicrotask(() => {
          port.emit('message', {
            type: MEMORY_OWNER_RPC, kind: 'result', id: frame.id, ok: true,
            result: {
              found: true, epoch: 'e-ref', revision: 1, deadlineAt: Date.now() + 115, retried: false,
              result: { status: 'hit', text: 'OLD_REV1_A', partial: false, hits: [{ text: 'OLD_REV1_A', names: ['a'] }] },
            },
          })
        })
      } else {
        void slowClaimB.promise.then(res => {
          port.emit('message', { type: MEMORY_OWNER_RPC, kind: 'result', id: frame.id, ok: true, result: res })
        })
      }
      return true
    }
    if (frame.method === 'adapter') {
      const { method } = frame.input as { method: string }
      if (method === 'automaticRecall') {
        refreshCount++
        queueMicrotask(() => {
          port.emit('message', {
            type: MEMORY_OWNER_RPC, kind: 'result', id: frame.id, ok: true,
            result: { status: 'hit', text: 'FRESH_REV2_A', partial: false, hits: [{ text: 'FRESH_REV2_A', names: ['a2'] }] },
          })
        })
        return true
      }
      queueMicrotask(() => {
        port.emit('message', { type: MEMORY_OWNER_RPC, kind: 'result', id: frame.id, ok: true, result: { nextSeq: 0, createdAt: 0 } })
      })
    }
    return true
  }

  const ctx = new Context()
  const preStepHandlers: Array<(payload: any, next: () => Promise<any>) => Promise<any>> = []
  const fakeCtx = Object.assign(ctx, {
    agents: { list: () => [] },
    sessions: { list: () => [], flush: async () => true, get: () => undefined },
    tools: { register: () => () => {} },
    llm: { stream: async function* () {} },
    on(event: string, listener: (...args: any[]) => any) {
      if (event === 'agent/pre-step') preStepHandlers.push(listener)
      return () => {}
    },
    inject() { return () => {} },
    effect() { return () => {} },
  })

  const owner = applyMemoryAdapter(fakeCtx as unknown as Context, { host: true, dataRoot: root }, port as unknown as NodeJS.Process)
  t.after(async () => { await owner.close() })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(owner.ready(), true)

  const msgA = createUserMessage({ content: [{ type: 'text', text: withRequestSource('问题 A', reqA, '问题 A').text }], source: { kind: 'user' } })
  const msgB = createUserMessage({ content: [{ type: 'text', text: withRequestSource('问题 B', reqB, '问题 B').text }], source: { kind: 'user' } })
  const fakeSession = { id: 'sess-ref', header: { cwd: dir }, seq: 0, inheritedEventCount: 0, snapshotEvents: () => [] }
  const preStep = preStepHandlers[0]!

  const decisionPromise = preStep({
    agent: { session: fakeSession },
    turn: 1,
    signal: new AbortController().signal,
    modelSelection: { provider: 'test', model: 'm' },
  }, async () => ({ kind: 'enter', messages: [msgA, msgB] }))

  // Let A settle at rev 1 while B is still pending, then bump revision to 2 before B resolves!
  await new Promise(resolve => setTimeout(resolve, 15))
  port.emit('message', {
    type: MEMORY_OWNER_RPC, kind: 'event',
    event: { type: 'memory_owner_change', protocol: MEMORY_HOST_PROTOCOL, epoch: 'e-ref', revision: 2 },
  })
  slowClaimB.resolve({
    found: true, epoch: 'e-ref', revision: 2,
    result: { status: 'hit', text: 'REV2_B', partial: false, hits: [{ text: 'REV2_B', names: ['b'] }] },
  })

  const decision = await decisionPromise
  assert.equal(refreshCount, 1, 'stale hit A must refresh once within its remaining original deadline')
  const appendedRecall = decision.messages.slice(2)
  assert.equal(appendedRecall.length, 2)
  assert.match(appendedRecall[0].content[0].text, /FRESH_REV2_A/, 'refreshed hit A must carry rev 2 evidence')
  assert.match(appendedRecall[1].content[0].text, /REV2_B/)
})

test('real DSH agent-loop emits 0 memory_context receipts on prepareRequest failure and post-pre-step cancel before commit, and 1 on committed turn (R4 P2-7)', async t => {
  const { dir } = scratch(t, 'memory-r4-dsh-prepare-receipt-')
  const config = path.join(dir, 'cordis.yml')
  const root = path.join(dir, 'memory')
  writeFileSync(config, JSON.stringify([
    'dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-agent-loop', 'dsh-tool-executor-native', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-user-questions',
  ].map(name => ({ id: name, name: '@deepseek-ai/' + name }))))

  const ctx = await boot('memory-r4-receipt-test', config, [], undefined, new URL('../package.json', import.meta.url).href)
  t.after(async () => { await ctx.fiber.dispose() })

  const port = new EventEmitter() as EventEmitter & { connected: boolean, send: (frame: unknown, cb?: () => void) => boolean }
  port.connected = true
  const contextUsedReports: unknown[] = []
  port.send = (raw, cb) => {
    cb?.()
    const frame = ownerRpcFrame(raw)
    if (!frame || frame.kind !== 'request') return true
    if (frame.method === 'attach') {
      queueMicrotask(() => {
        port.emit('message', { type: MEMORY_OWNER_RPC, kind: 'result', id: frame.id, ok: true, result: { state: ownerState('e-dsh', 1) } })
      })
      return true
    }
    if (frame.method === 'claimPrefetch') {
      queueMicrotask(() => {
        port.emit('message', {
          type: MEMORY_OWNER_RPC, kind: 'result', id: frame.id, ok: true,
          result: {
            found: true, epoch: 'e-dsh', revision: 1,
            result: { status: 'hit', text: 'DSH_EVIDENCE', partial: false, hits: [{ text: 'DSH_EVIDENCE', names: ['e'] }] },
          },
        })
      })
      return true
    }
    if (frame.method === 'adapter') {
      const { method, args } = frame.input as { method: string, args: unknown[] }
      if (method === 'reportContextUsed') {
        contextUsedReports.push(args[0])
        queueMicrotask(() => { port.emit('message', { type: MEMORY_OWNER_RPC, kind: 'result', id: frame.id, ok: true, result: undefined }) })
        return true
      }
      if (method === 'automaticRecall') {
        queueMicrotask(() => {
          port.emit('message', {
            type: MEMORY_OWNER_RPC, kind: 'result', id: frame.id, ok: true,
            result: { status: 'hit', text: 'DSH_EVIDENCE', partial: false, hits: [{ text: 'DSH_EVIDENCE', names: ['e'] }] },
          })
        })
        return true
      }
      queueMicrotask(() => {
        port.emit('message', { type: MEMORY_OWNER_RPC, kind: 'result', id: frame.id, ok: true, result: { nextSeq: 0, createdAt: 0 } })
      })
    }
    return true
  }

  let prepareMode: 'fail' | 'cancel' | 'ok' = 'fail'
  let prepareCalls = 0
  let cancelCurrentAgent: (() => void) | undefined
  class TestPrepareAdapter extends LlmAdapter {
    override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
      prepareCalls++
      if (prepareMode === 'fail') throw new Error('simulated prepareRequest failure after pre-step')
      if (prepareMode === 'cancel') {
        cancelCurrentAgent?.()
        await new Promise(resolve => setTimeout(resolve, 10))
        signal?.throwIfAborted()
      }
      return super.prepareCall(provider, model, signal)
    }
    override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'committed reply' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'committed reply' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mock'], new TestPrepareAdapter())

  const owner = applyMemoryAdapter(ctx, { host: true, dataRoot: root }, port as unknown as NodeJS.Process)
  t.after(async () => { await owner.close() })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(owner.ready(), true)

  const handle = await ctx.agents.create({
    sessionId: SessionId(randomUUID()),
    agentOptions: { provider: 'mock', model: 'test-model' },
  })
  t.after(async () => { await handle.dispose() })
  cancelCurrentAgent = () => { void handle.agent.cancel({ kind: 'user' }) }

  const runTurn = async (text: string) => {
    const done = deferred<void>()
    const off = ctx.on('session/event', (session, event) => {
      if (session.id === handle.agent.session.id && event.type === 'turn/end') {
        off()
        done.resolve()
      }
    })
    handle.agent.send(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), 'next-turn', true)
    await done.promise
  }

  // Turn 1: real pre-step injects <memory-recall>, then real prepareRequest throws BEFORE user/message commit -> 0 receipts!
  prepareMode = 'fail'
  await runTurn('第一次查询触发 prepareRequest 失败')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(prepareCalls, 1, 'real dsh-agent-loop must reach prepareCall right after pre-step')
  assert.equal(contextUsedReports.length, 0, 'real prepareRequest failure after pre-step must emit 0 memory_context receipts')

  // Turn 2: real pre-step injects <memory-recall>, then real agent.cancel() fires during prepareCall BEFORE commit -> 0 receipts!
  prepareMode = 'cancel'
  await runTurn('第二次查询在 pre-step 后取消')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(prepareCalls, 2)
  assert.equal(contextUsedReports.length, 0, 'real post-pre-step cancellation before commit must emit 0 memory_context receipts')

  // Turn 3: real committed turn -> EXACTLY 1 receipt!
  prepareMode = 'ok'
  await runTurn('第三次查询正常提交')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(prepareCalls, 3)
  assert.equal(contextUsedReports.length, 1, 'real committed turn must emit exactly 1 memory_context receipt')
})
