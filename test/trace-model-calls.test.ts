import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openTraceDb, traceStepDigest } from '../plugins/trace/lib/store.ts'
import { readSessionTrace } from '../src/backend/dsh-log.ts'
import type { ModelCallSummary, ModelRequest } from '../src/shared/trace.ts'

const SESSION = '11111111-2222-3333-4444-555555555555'
const call: ModelCallSummary = {
  sessionId: SESSION, turn: 1, step: 1, at: 1000, status: 'running', provider: 'deepseek', model: 'deepseek-v4',
  attempts: 1, inputTokens: null, outputTokens: null, durationMs: null,
}
const request: ModelRequest = {
  provider: 'deepseek', model: 'deepseek-v4', config: { provider: 'deepseek', model: 'deepseek-v4' },
  messages: [
    { role: 'system', content: [{ type: 'text', text: '你是 Viva' }] },
    { role: 'developer', content: [{ type: 'tool-addition', toolName: 'read' }] },
    { role: 'user', content: [{ type: 'text', text: '长'.repeat(100_000) }] },
  ],
  tools: [{ name: 'read', input_schema: { type: 'object' } }],
}

function store(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-model-'))
  const db = openTraceDb({ file: path.join(dir, 'trace.db') })
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return db
}

test('model requests retain every role and full text while settlement replaces only summary metadata', (t) => {
  const db = store(t)
  db.recordCall(call, request)
  db.recordCall({ ...call, status: 'completed', inputTokens: 1200, outputTokens: 80, durationMs: 3400, attempts: 2 })

  const detail = db.callOf(SESSION, 1, 1)
  assert.equal(detail?.call.status, 'completed')
  assert.equal(detail?.call.attempts, 2)
  assert.equal(detail?.call.inputTokens, 1200)
  assert.equal(detail?.request?.messages.length, 3)
  assert.equal((detail?.request?.messages[2] as { content: Array<{ text: string }> }).content[0].text.length, 100_000)
  assert.deepEqual(db.callsOf(SESSION).map(item => item.status), ['completed'])
})

test('restored traces include model nodes in timestamp order and omit calls beyond the read boundary', async t => {
  const db = store(t)
  db.recordCall(call, request)
  db.recordCall({ ...call, step: 2, at: 3000, status: 'completed' }, { ...request, messages: [] })
  db.recordSteps(SESSION, [{ seq: 2, at: 2000, kind: 'thought', text: '先读文件' }])

  const { trace, available } = await readSessionTrace({ dshHome: path.join(os.tmpdir(), 'no-dsh'), traceDb: db, sessionIds: [SESSION], until: 2500 })
  assert.equal(available, true)
  assert.deepEqual(trace.timeline.map(item => item.kind), ['model', 'thought'])
  assert.equal(trace.modelCalls[`${SESSION}:1:1`].model, 'deepseek-v4')
})

test('erasing a native step also erases requests that could carry its content in later prompts', t => {
  const db = store(t)
  const step = { seq: 2, at: 2000, kind: 'thought' as const, text: '需要擦除的内容' }
  db.recordSteps(SESSION, [step])
  db.recordCall(call, request)

  assert.equal(db.eraseSteps(SESSION, [{ seq: step.seq, digest: traceStepDigest(step) }]), true)
  assert.equal(db.callOf(SESSION, 1, 1), null)
  assert.deepEqual(db.stepsOf(SESSION), [])
})

test('plain, failed and in-flight model calls cannot republish a withdrawn request until verified cold cleanup', t => {
  const db = store(t)
  db.recordCall(call, request)
  db.recordCall({ ...call, step: 2, status: 'failed' }, request)
  db.recordCall({ ...call, step: 3, status: 'completed' }, request)
  db.eraseSessionRequests('cut-a', [SESSION])
  assert.deepEqual(db.callsOf(SESSION), [])
  db.recordCall({ ...call, status: 'failed' })
  db.recordCall({ ...call, step: 4 }, request)
  assert.equal(db.callOf(SESSION, 1, 4), null)
  const fork = '99999999-2222-3333-4444-555555555555'
  db.recordCall({ ...call, sessionId: fork }, request)
  db.eraseSessionRequests('cut-b', [SESSION])
  db.eraseSessionRequests('cut-a', [SESSION, fork], true)
  assert.deepEqual(db.callsOf(fork), [])
  db.recordCall({ ...call, step: 5 }, request)
  assert.equal(db.callOf(SESSION, 1, 5), null)
  db.eraseSessionRequests('cut-b', [SESSION], true)
  db.recordCall({ ...call, turn: 2 }, { ...request, messages: [] })
  db.eraseSessionRequests('cut-a', [SESSION])
  assert.deepEqual(db.callOf(SESSION, 2, 1)?.request?.messages, [])
})
