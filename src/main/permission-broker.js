/**
 * Parks ACP permission requests until the user answers in the renderer.
 * Unknown or missing option ids resolve as "cancelled" so the agent never hangs on bad input.
 */
export function createPermissionBroker() {
  const pending = new Map()
  let seq = 0

  function create(params) {
    const requestId = `perm-${++seq}`
    const promise = new Promise((resolve) => {
      pending.set(requestId, { resolve, params })
    })
    return { requestId, promise }
  }

  function resolve(requestId, optionId) {
    const entry = pending.get(requestId)
    if (!entry) return false
    pending.delete(requestId)
    const isKnownOption = Boolean(optionId) && (entry.params.options ?? []).some((o) => o.optionId === optionId)
    entry.resolve(
      isKnownOption ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } },
    )
    return true
  }

  /** @param {string} [sessionId] only that session's requests (a background task's stay when the main turn stops) */
  function cancelAll(sessionId) {
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
