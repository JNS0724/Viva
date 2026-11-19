import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { createToolBudgetWatchdog } from '../src/backend/tool-budget-watchdog.ts'
import { currentToolBudget, executeToolCall, toolBudgetMs } from '../src/shared/node/tool-call-budget.ts'

const done: ToolExecutionResult = { content: [], isError: false, value: null }
function invocation(name: string, signal = new AbortController().signal): ToolDispatchExecution {
  const callId = ToolCallId('call')
  return { name, callId, rootCallId: callId, arguments: {}, signal, token: Symbol() as ToolDispatchExecution['token'] }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('default budget is 5 seconds and a declared budget can cross it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const execute = (declared?: number) => {
    const exec = invocation('new_tool')
    return executeToolCall(exec, () => new Promise(resolve => exec.signal.addEventListener('abort', () => resolve(done))), { declared })
  }
  const defaultTool = execute()
  t.mock.timers.tick(5_000)
  assert.match(JSON.stringify(await defaultTool), /TOOL_TIMEOUT/)
  let settled = false
  const longTool = execute(30_000).then(result => { settled = true; return result })
  t.mock.timers.tick(5_001); await flush()
  assert.equal(settled, false)
  t.mock.timers.tick(24_999)
  assert.match(JSON.stringify(await longTool), /TOOL_TIMEOUT/)
  assert.equal(toolBudgetMs('memory_recall'), 10_000)
  assert.equal(toolBudgetMs('schedule_list'), 5_000)
  assert.equal(toolBudgetMs('viva_mcp_import'), 60_000)
})

test('credential input pauses execution time, and user cancellation still reaches the tool', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const caller = new AbortController()
  const exec = invocation('viva_mcp_add', caller.signal)
  const result = executeToolCall(exec, () => {
    currentToolBudget()!.waitForInput(true)
    return new Promise(resolve => exec.signal.addEventListener('abort', () => resolve(done), { once: true }))
  }, { mutates: true })
  t.mock.timers.tick(100_000)
  assert.equal(exec.signal.aborted, false)
  caller.abort()
  assert.equal(exec.signal.aborted, true)
  await result
})

test('timed-out reads and writes communicate distinct outcomes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const [name, mutates, status] of [['memory_recall', false, 'unavailable'], ['memory_remember', true, 'unknown']] as const) {
    const exec = invocation(name)
    const result = executeToolCall(exec, () => new Promise(resolve => exec.signal.addEventListener('abort', () => resolve(done))), { declared: 10, mutates })
    t.mock.timers.tick(10)
    assert.deepEqual(JSON.parse((await result).content.find(part => part.type === 'text')!.text), { status, reason: 'timeout' })
  }
})

test('backend watchdog ignores paused work and old turns, and times out unacknowledged dispatch', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let turn = 'old'
  const stuck: string[] = []
  const watchdog = createToolBudgetWatchdog({ currentTurn: id => id === 'session' ? turn : undefined, onStuck: id => stuck.push(id), graceMs: 2 })
  const notice = (remainingMs: number | null, callId = 'call') => watchdog.receive({
    type: 'viva_tool_budget', sessionId: 'session', callId, phase: 'execute', remainingMs,
  })
  notice(10); notice(null)
  t.mock.timers.tick(100)
  assert.deepEqual(stuck, [])
  notice(10); turn = 'new'
  t.mock.timers.tick(12)
  assert.deepEqual(stuck, [])
  notice(10, 'new call')
  t.mock.timers.tick(12)
  assert.deepEqual(stuck, ['session'])
})

test('dispatch logging retains caller cancellation after a finished tool releases its timer', async () => {
  const caller = new AbortController()
  const exec = invocation('memory_read', caller.signal)
  let duringDispatch: AbortSignal | undefined
  await executeToolCall(exec, async () => {
    duringDispatch = exec.signal
    return done
  })
  assert.equal(exec.signal, caller.signal)
  assert.equal(duringDispatch?.aborted, false)
  caller.abort()
  assert.equal(duringDispatch?.aborted, true)
})
