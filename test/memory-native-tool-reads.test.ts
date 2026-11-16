import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ResolvedToolSet, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { trackNativeToolReads } from '../plugins/memory/lib/native/tool-reads.ts'
import type { NativeToolCall, NativeToolResult } from '../src/memory/node/native-tool-reads.ts'

const toolSet = (): ResolvedToolSet => ({ dispose() {}, view: () => new Map() })
const token = (): ToolExecutionToken => Symbol() as ToolExecutionToken

test('native read receipt follows the admitted executor rather than a caller reusing its public tool ID', () => {
  const session = Session.create(SessionId('tool-evidence'))
  const signal = new AbortController().signal
  const tools = toolSet()
  const settled: Array<{ call: NativeToolCall, result: NativeToolResult }> = []
  const reads = trackNativeToolReads((call, result) => { settled.push({ call, result }) })
  const callId = ToolCallId('shared-call-id')
  const exec: ToolExecution = { callId, rootCallId: callId, name: 'memory_read', arguments: {}, signal, toolSet: tools, token: token() }
  reads.assembly(session, signal, tools)
  reads.step(session, 1, 1, signal)
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name: exec.name, arguments: '{}' })
  reads.observe(session, call)

  for (const unrelated of [
    { ...exec, token: token(), name: 'memory_recall' },
    { ...exec, token: token(), toolSet: undefined },
    { ...exec, token: token(), toolSet: toolSet() },
    { ...exec, token: token(), signal: new AbortController().signal },
  ]) {
    reads.bind(session, unrelated)
    assert.equal(reads.acquire(session, unrelated, 0), undefined)
  }
  reads.bind(session, exec)
  assert.equal(reads.acquire(session, { ...exec, token: token() }, 0), undefined)
  const lease = reads.acquire(session, { ...exec, signal: new AbortController().signal }, 0)
  assert.ok(lease)
  assert.equal(lease.current(), true)
  assert.equal(reads.acquire(session, exec, 0), undefined)
  const result = session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: [], isError: false }) },
  { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  reads.observe(session, result)
  assert.equal(lease.current(), false)
  assert.deepEqual(settled.map(receipt => [receipt.call.seq, receipt.result.seq]), [[call.seq, result.seq]])
})

test('compaction input proof precedes a cancelled summary and preserves an independent failed region', async () => {
  const { randomUUID } = await import('node:crypto')
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const { recordCompactionRequest } = await import('../plugins/memory/lib/native/compaction-inputs.ts')
  const { nativeCompactionCopies, projectNativeCompaction } = await import('../plugins/memory/lib/native/project-native-compactions.ts')
  const session = Session.create(SessionId('failed-compaction'))
  const input = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'erased original' }] }), { surfaceOp: 'append' })
  const survivor = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'independent original' }] }), { surfaceOp: 'append' })
  const compactionId = randomUUID() as import('@deepseek-ai/dsh-compaction').CompactionId
  session.append('compaction/start', { compactionId, turn: null })
  assert.throws(() => recordCompactionRequest(session, [{ ...input.data, content: [{ type: 'text', text: 'different body' }] }]), /unverified input/)
  recordCompactionRequest(session, [input.data, { role: 'user', content: [{ type: 'text', text: 'instruction' }] }])
  // Cancellation bypasses the stock summary-error hook, leaving just this error.
  const failure = session.append('compaction/end', { compactionId, turn: null, error: 'provider echoed erased original' })
  const nextId = randomUUID() as import('@deepseek-ai/dsh-compaction').CompactionId
  session.append('compaction/start', { compactionId: nextId, turn: null })
  recordCompactionRequest(session, [survivor.data])
  const nextFailure = session.append('compaction/end', { compactionId: nextId, turn: null, error: 'unrelated failure is retained' })
  const copies = nativeCompactionCopies(session.snapshotEvents(), new Set([input.seq]))
  assert.deepEqual([...copies.keys()], [failure.seq])
  assert.doesNotMatch(JSON.stringify(projectNativeCompaction(failure)), /erased original/)
  assert.equal(copies.has(nextFailure.seq), false)
})
