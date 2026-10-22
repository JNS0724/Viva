/**
 * Words the user sends while the agent works, on the app's side of the steer contract (version 1, see
 * plugins/steer/lib/channel.js): handed to the viva-steer plugin inside dsh, which gives them to the running
 * turn. Every request is answered, by the plugin or, when it does not, by a timeout.
 */
const STEER_TIMEOUT_MS = 5_000
/** No answer from the plugin: it is not loaded, or dsh is gone. */
export const NO_PLUGIN = 'unavailable'

export type SteerResult = { ok: boolean, reason?: string }

export interface SteerDesk {
  /** @param session the turn to steer: the main conversation's, or a background task's */
  steer: (text: string, session?: string | null) => Promise<SteerResult>
  receive: (message: any) => void
  /** dsh is going away or the session is switched: nothing will answer. */
  closeAll: () => void
}

export function createSteerDesk({ send, sessionId, timeoutMs = STEER_TIMEOUT_MS }: {
  send: (message: object) => void, sessionId: () => string | null, timeoutMs?: number,
}): SteerDesk {
  const waiting = new Map<string, { resolve: (result: SteerResult) => void, timer: ReturnType<typeof setTimeout> }>()
  let seq = 0

  function settle(id: string, result: SteerResult): void {
    const entry = waiting.get(id)
    if (!entry) return
    waiting.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(result)
  }

  function steer(text: string, session: string | null = sessionId()): Promise<SteerResult> {
    if (!session) return Promise.resolve({ ok: false, reason: NO_PLUGIN })
    const id = `s${++seq}-${Date.now().toString(36)}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(id, { ok: false, reason: NO_PLUGIN }), timeoutMs)
      timer.unref?.()
      waiting.set(id, { resolve, timer })
      send({ type: 'steer', id, sessionId: session, text })
    })
  }

  function receive(message: any): void {
    if (message?.type !== 'steer_result' || typeof message.id !== 'string' || typeof message.ok !== 'boolean') return
    settle(message.id, message.ok ? { ok: true } : { ok: false, reason: typeof message.reason === 'string' ? message.reason : NO_PLUGIN })
  }

  function closeAll(): void {
    for (const id of [...waiting.keys()]) settle(id, { ok: false, reason: NO_PLUGIN })
  }

  return { steer, receive, closeAll }
}
