import { objectOf } from '../memory/contracts/unknown-value.ts'

/** Gives a cooperative dsh tool time to publish its timeout before asking to stop the turn. */
const TOOL_SETTLE_GRACE_MS = 500

export function createToolBudgetWatchdog({ currentTurn, onStuck, graceMs = TOOL_SETTLE_GRACE_MS }: {
  currentTurn(session: string): string | undefined
  onStuck(session: string): void
  graceMs?: number
}) {
  const watched = new Map<string, ReturnType<typeof setTimeout>>()
  function stop(key: string) {
    clearTimeout(watched.get(key))
    watched.delete(key)
  }
  return {
    receive(raw: unknown) {
      const notice = objectOf(raw)
      if (notice?.type !== 'viva_tool_budget') return false
      const { sessionId, callId, phase, remainingMs } = notice
      if (typeof sessionId !== 'string' || typeof callId !== 'string' || callId.length > 256
        || (phase !== 'execute' && phase !== 'prepare')) return true
      const turn = currentTurn(sessionId)
      if (!turn) return true
      const key = JSON.stringify([turn, callId, phase])
      stop(key)
      if (typeof remainingMs !== 'number' || !Number.isFinite(remainingMs) || remainingMs < 0) return true
      const timer = setTimeout(() => {
        watched.delete(key)
        if (currentTurn(sessionId) === turn) onStuck(sessionId)
      }, Math.min(remainingMs, 2 ** 31 - 1 - graceMs) + graceMs)
      timer.unref?.()
      watched.set(key, timer)
      return true
    },
    clear() { for (const key of watched.keys()) stop(key) },
  }
}
