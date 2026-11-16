import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { MemoryControlReceipt } from './owner-port.ts'

/** Local command outcomes have their own DSH presentation; they are never model messages. */
export function createControlReceipts() {
  const pending = new Map<string, { agent: Agent, receipt: MemoryControlReceipt }>()
  let commands: Pick<CommandRuntime, 'execute'> | undefined
  return {
    available: () => commands !== undefined,
    bind(runtime: Pick<CommandRuntime, 'register' | 'execute'>) {
      const dispose = runtime.register({
        name: 'memory-result', description: 'Show a completed local memory operation', recordInput: false,
        handler({ agent, rawInput }) {
          const token = rawInput.trim()
          const entry = pending.get(token)
          if (!entry || entry.agent !== agent) return { kind: 'error', text: 'No completed memory operation is available.' }
          pending.delete(token)
          return { kind: 'success', text: entry.receipt.kind === 'stop'
            ? `Memory #${entry.receipt.targetId} is no longer used.`
            : `Memory #${entry.receipt.targetId} has been corrected. Its history is preserved.` }
        },
      })
      commands = runtime
      return () => { if (commands === runtime) commands = undefined; dispose() }
    },
    async publish(agent: Agent, receipts: readonly MemoryControlReceipt[]) {
      if (!commands) throw new Error('Local memory receipts require the DSH commands service')
      for (const receipt of receipts) {
        const token = randomUUID()
        pending.set(token, { agent, receipt })
        try {
          // The mutation has already committed. A user cancellation cannot turn its receipt into a failure.
          const execution = await commands.execute(agent, `/memory-result ${token}`, [], new AbortController().signal)
          if (execution?.result.kind !== 'success') throw new Error('Local memory receipt could not be published')
        } finally { pending.delete(token) }
      }
    },
  }
}
