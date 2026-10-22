/** The answer the ACP agent gets for a permission request. */
export type PermissionOutcome = { outcome: { outcome: 'selected', optionId: string } | { outcome: 'cancelled' } }

/** What the broker needs of an ACP permission request. */
interface PermissionParams { sessionId?: string, options?: Array<{ optionId: string }> }

/**
 * Parks ACP permission requests until the user answers in the renderer.
 * Unknown or missing option ids resolve as "cancelled" so the agent never hangs on bad input.
 */
export function createPermissionBroker() {
  const pending = new Map<string, { resolve: (outcome: PermissionOutcome) => void, params: PermissionParams }>()
  let seq = 0

  function create(params: PermissionParams): { requestId: string, promise: Promise<PermissionOutcome> } {
    const requestId = `perm-${++seq}`
    const promise = new Promise<PermissionOutcome>((resolve) => {
      pending.set(requestId, { resolve, params })
    })
    return { requestId, promise }
  }

  function resolve(requestId: string, optionId: string | null): boolean {
    const entry = pending.get(requestId)
    if (!entry) return false
    pending.delete(requestId)
    const isKnownOption = Boolean(optionId) && (entry.params.options ?? []).some((o) => o.optionId === optionId)
    entry.resolve(
      isKnownOption ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } },
    )
    return true
  }

  /** @param sessionId only that session's requests (a background task's stay when the main turn stops) */
  function cancelAll(sessionId?: string): void {
    for (const [requestId, entry] of [...pending]) {
      if (sessionId === undefined || entry.params.sessionId === sessionId) resolve(requestId, null)
    }
  }

  return {
    create,
    resolve,
    cancelAll,
    get size() {
      return pending.size
    },
  }
}
