import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { continueText, extractFeedContinuationSupplement } from '../src/shared/feed-continuation.ts'
import { requestsIn } from '../src/shared/request-routing/header.ts'
import { leadingTaskRequestId, taskRequestsIn, withoutTaskHeaders, withTaskRequestSource } from '../src/shared/request-routing/task-header.ts'
import { applyMemoryAdapter } from '../plugins/memory/lib/adapter.ts'
import { DAILY_MEMORY_DEFAULTS } from '../src/memory/contracts/memory-daily-defaults.ts'
import { MEMORY_HOST_PROTOCOL } from '../src/memory/contracts/host.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { createMemoryRuntime } from '../src/memory/node/runtime.ts'
import { RESIDENT_PROFILE_PATH } from '../src/memory/core/resident-profile.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { eventually } from './fixtures/eventually.ts'
import { scratch } from './fixtures/scratch.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

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

test('real DSH agent-loop emits 0 memory_context receipts on prepareRequest failure and post-pre-step cancel before commit, and 1 on committed turn (R4 P2-7)', { timeout: 30_000 }, async t => {
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
  const hostResults = new Map<string, ReturnType<typeof deferred<{ ok: boolean, result?: unknown, error?: unknown }>>>()
  port.send = (raw, cb) => {
    cb?.()
    if (raw && typeof raw === 'object') {
      const msg = raw as { type?: string, requestId?: string, ok?: boolean, result?: unknown, error?: unknown }
      if (msg.type === 'memory_owner_context_used') contextUsedReports.push(msg)
      if (msg.type === 'memory_host_result' && typeof msg.requestId === 'string') {
        const waiter = hostResults.get(msg.requestId)
        hostResults.delete(msg.requestId)
        waiter?.resolve({ ok: Boolean(msg.ok), result: msg.result, error: msg.error })
      }
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
  assert.ok(await eventually(() => owner.ready(), { timeoutMs: 15_000 }))

  const hostCall = async (method: string, input: unknown) => {
    const requestId = randomUUID()
    const waiter = deferred<{ ok: boolean, result?: unknown, error?: unknown }>()
    hostResults.set(requestId, waiter)
    port.emit('message', {
      type: 'memory_host_request',
      protocol: MEMORY_HOST_PROTOCOL,
      requestId,
      epoch: owner.epoch!,
      method,
      input,
    })
    const res = await waiter.promise
    assert.equal(res.ok, true, JSON.stringify(res.error))
    return res.result
  }

  await hostCall('createFile', { args: [{ operationId: randomUUID(), title: '周报规范', text: '周报每周五下班前交给产品组。' }] })

  const sessionId = SessionId(randomUUID())
  const handle = await ctx.agents.create({
    sessionId,
    meta: { cwd: dir },
    agentOptions: { provider: 'mock', model: 'test-model' },
  })
  t.after(async () => { await handle.dispose() })
  cancelCurrentAgent = () => { void handle.agent.cancel({ kind: 'user' }) }

  const runTurn = async (text: string) => {
    const sourceId = randomUUID()
    await hostCall('sourceAlias', {
      operationId: sourceId,
      sourceId,
      session: String(sessionId),
      conversation: String(sessionId),
      text,
      wireText: text,
      cwd: handle.agent.session.header.cwd ?? dir,
      origin: 'original',
    })
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
  await runTurn('帮我写周报')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(prepareCalls, 1, 'real dsh-agent-loop must reach prepareCall right after pre-step')
  assert.equal(contextUsedReports.length, 0, 'real prepareRequest failure after pre-step must emit 0 memory_context receipts')

  // Turn 2: real pre-step injects <memory-recall>, then real agent.cancel() fires during prepareCall BEFORE commit -> 0 receipts!
  prepareMode = 'cancel'
  await runTurn('帮我写周报')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(prepareCalls, 2)
  assert.equal(contextUsedReports.length, 0, 'real post-pre-step cancellation before commit must emit 0 memory_context receipts')

  // Turn 3: real committed turn -> EXACTLY 1 receipt!
  prepareMode = 'ok'
  await runTurn('帮我写周报')
  assert.ok(await eventually(() => contextUsedReports.length === 1, { timeoutMs: 5_000 }), 'real committed turn must emit exactly 1 memory_context receipt')
  assert.equal(prepareCalls, 3)
})
