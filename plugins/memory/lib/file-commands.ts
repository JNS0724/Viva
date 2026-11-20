import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandRuntime } from '@deepseek-ai/dsh-commands'
import { memoryHostFailure } from '../../../src/memory/contracts/domain-error.ts'
import { memoryFileCreateRequest } from '../../../src/memory/contracts/file-management.ts'
import { APP_WRITE_TIMEOUT_MS, createRequestBudget } from '../../../src/shared/request-budget.ts'
import type { createRemoteMemoryOwner } from './remote-owner.ts'

function operationOf(commandId: CommandInvocation['commandId']) {
  const hex = createHash('sha256').update('viva-memory-command:').update(commandId).digest('hex')
  // DSH mints a unique command ID for each invocation. Encode it as the owner’s UUIDv8 operation ID.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Commands keep their input and outcomes outside of the model transcript. */
export function registerMemoryFileCommands(commands: Pick<CommandRuntime, 'register'>,
  owner: Pick<ReturnType<typeof createRemoteMemoryOwner>, 'rememberStandaloneFile' | 'forgetStandaloneFile'>,
  prepare: (agent: Agent, signal: AbortSignal) => Promise<boolean>) {
  const unavailable = { kind: 'error', text: 'Memory is unavailable in this session. Try again once the session is ready.' } as const
  const notFound = { kind: 'error', text: 'No memory with this ID is available in this session.' } as const
  const validSession = ({ agent, signal }: CommandInvocation) => !signal.aborted
    && agent.session.header.origin !== 'subagent' && agent.session.header.origin !== 'schedule'
  const failed = (error: unknown) => {
    const { domainCode } = memoryHostFailure(error)
    if (domainCode === 'not.found') return notFound
    if (domainCode === 'credentials') return { kind: 'error', text: 'Memory cannot save credentials.' } as const
    if (domainCode === 'invalid.text') return { kind: 'error', text: 'Enter valid text to save.' } as const
    if (domainCode === 'revision.conflict') return { kind: 'error', text: 'The memory changed. Look it up again and retry.' } as const
    return unavailable
  }

  async function write(invocation: CommandInvocation, work: (session: string, budget: ReturnType<typeof createRequestBudget>) => Promise<string>) {
    if (!validSession(invocation)) return unavailable
    const budget = createRequestBudget(APP_WRITE_TIMEOUT_MS, invocation.signal)
    let dispatched = false
    try {
      if (!await budget.run(() => prepare(invocation.agent, budget.signal))) return unavailable
      const text = await budget.run(() => {
        dispatched = true
        return work(String(invocation.agent.session.id), budget)
      })
      return { kind: 'success', text } as const
    } catch (error) {
      if (dispatched && (budget.signal.aborted || (error instanceof Error && 'code' in error && error.code === 'timeout'))) {
        return { kind: 'error', text: 'The memory change was not confirmed. Check the saved memories before retrying.' } as const
      }
      return failed(error)
    } finally { budget.close() }
  }

  const disposers = [commands.register({
    name: 'memory-remember', description: 'Save a memory in this session’s project, or to personal memory outside a project.',
    input: { hint: 'Text to remember' }, recordInput: false,
    async handler(invocation) {
      const { rawInput, commandId } = invocation
      const text = rawInput.slice(1)
      const request = memoryFileCreateRequest.safeParse({ operationId: operationOf(commandId), text })
      if (!request.success || !text.trim()) return { kind: 'error', text: 'Enter text after /memory-remember.' }
      return write(invocation, async (session, budget) => {
        const receipt = await owner.rememberStandaloneFile(session, request.data, { signal: budget.signal, budgetMs: budget.remainingMs() })
        return `Saved memory ${receipt.identity.id}.`
      })
    },
  }), commands.register({
    name: 'memory-forget', description: 'Delete a saved memory file by its exact ID.',
    input: { hint: 'Memory ID' }, recordInput: false,
    async handler(invocation) {
      const { rawInput, commandId } = invocation
      const id = rawInput.trim()
      if (!/^(?:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}|daily:[\da-f]{64})$/u.test(id)) {
        return { kind: 'error', text: 'Enter an exact memory ID after /memory-forget.' }
      }
      return write(invocation, async (session, budget) => {
        const cleanup = await owner.forgetStandaloneFile(session, id, operationOf(commandId), { signal: budget.signal, budgetMs: budget.remainingMs() })
        return cleanup === 'complete' ? 'Memory file deleted.' : 'Memory file deleted. File cleanup is pending.'
      })
    },
  })]
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
