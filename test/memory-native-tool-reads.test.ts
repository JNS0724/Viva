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
