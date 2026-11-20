import { AsyncLocalStorage } from 'node:async_hooks'
import type { ToolBudgetNotice } from '../tool-budget-notice.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDispatchExecution, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { DEFAULT_TOOL_TIMEOUT_MS, createRequestBudget, RequestTimeout } from '../request-budget.ts'

// The native DSH tools belong to the installed SDK. App-owned tools declare their budgets when registered.
const nativeBudgets = new Map<string, number>([
  ['read', 10_000], ['read_image', 10_000], ['glob', 30_000], ['grep', 30_000],
])

const mainAgents = new WeakMap<Agent, (notice: ToolBudgetNotice) => void>()
const remaining = new WeakMap<ToolExecution, number>()
const active = new AsyncLocalStorage<ReturnType<typeof startToolPhase>>()
const memoryTools = new Set(['memory_recall', 'memory_read', 'memory_node_search', 'memory_remember'])
export const isMemoryTool = (name: string) => memoryTools.has(name)
export const enableMainToolBudgets = (agent: Agent, send: (notice: ToolBudgetNotice) => void) => { mainAgents.set(agent, send) }
export const toolBudgetMs = (name: string, declared?: number) => declared ?? nativeBudgets.get(name) ?? DEFAULT_TOOL_TIMEOUT_MS

export function budgetedTool(exec: ToolExecution) {
  return !!exec.agent && (isMemoryTool(exec.name) || mainAgents.has(exec.agent))
}

function startToolPhase(exec: ToolExecution, milliseconds: number, phase: ToolBudgetNotice['phase']) {
  const budget = createRequestBudget(milliseconds, exec.signal)
  const send = exec.agent && mainAgents.get(exec.agent)
  const report = (remainingMs: number | null) => {
    if (exec.agent) send?.({ type: 'viva_tool_budget', sessionId: String(exec.agent.session.id),
      callId: String(exec.callId), phase, remainingMs })
  }
  report(Math.max(0, milliseconds))
  return {
    ...budget,
    waitForInput(waiting: boolean) {
      if (waiting) { budget.pause(); report(null) }
      else {
        budget.resume()
        if (budget.signal.aborted) return
        try { report(budget.remainingMs()) }
        catch (error) { if (!(error instanceof RequestTimeout)) throw error }
      }
    },
    close() { budget.close(); report(null) },
  }
}

// DSH waits for approvals between preparation and dispatch. Retain only the duration left,
// so a permission card never consumes the budget and never masks caller cancellation.
export async function prepareToolCall<T>(exec: ToolExecution, declared: number | undefined, work: (signal: AbortSignal, remainingMs?: () => number) => Promise<T>) {
  if (!budgetedTool(exec)) return work(exec.signal)
  const budget = startToolPhase(exec, remaining.get(exec) ?? toolBudgetMs(exec.name, declared), 'prepare')
  try {
    const result = await budget.run(() => work(budget.signal, budget.remainingMs))
    remaining.set(exec, budget.remainingMs())
    return result
  } finally { budget.close() }
}

export const currentToolBudget = () => active.getStore()

function failure(message: string): ToolExecutionResult {
  return { content: [{ type: 'text', text: message }], isError: true,
    error: { message, info: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' } } }
}

export function toolTimeoutResult(name: string, mutates: boolean): ToolExecutionResult {
  const memory = isMemoryTool(name)
  const message = mutates ? 'The tool timed out. The result is unknown. Check the current state before retrying.'
    : 'The tool timed out before the query completed.'
  return failure(memory ? JSON.stringify({ status: mutates ? 'unknown' : 'unavailable', reason: 'timeout' }) : message)
}

export async function executeToolCall(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>, {
  declared, mutates = false, cooperativeReceipt = false,
}: { declared?: number, mutates?: boolean, cooperativeReceipt?: boolean } = {}) {
  const upstream = exec.signal
  const budget = startToolPhase(exec, remaining.get(exec) ?? toolBudgetMs(exec.name, declared), 'execute')
  remaining.delete(exec)
  // Native PTC may retain this signal through dispatch logging after the tool has settled.
  // Its caller's cancellation must remain observable after the local timer is disposed.
  exec.signal = AbortSignal.any([upstream, budget.signal])
  try {
    budget.remainingMs()
    // DSH requires dispatch middleware to drain. Tools hand the signal to their IO or
    // bound their own wait at the IPC boundary. The host can separately stop a stuck turn.
    const result = await active.run(budget, next)
    if (!cooperativeReceipt && !upstream.aborted) budget.remainingMs()
    return result
  } catch (error) {
    if (error instanceof RequestTimeout && !upstream.aborted) return toolTimeoutResult(exec.name, mutates)
    throw error
  } finally {
    exec.signal = upstream
    budget.close()
  }
}
