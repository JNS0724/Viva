/**
 * The plugin's side of the routing channel (src/shared/request-routing/channel.ts): the app binds main sessions and
 * answers every decision passed to it, accepted with a receipt for each action, or refused with the reason.
 */
import { randomUUID } from 'node:crypto'
import { asBind, asDecided, type Decided, type FastOutcome } from '../../../src/shared/request-routing/channel.ts'

/** Starting a task can take a while (dsh opens its session and connects the user's MCP servers). */
const DECIDE_WAIT_MS = 60_000

export function createHostChannel(port: NodeJS.Process, { onBind }: { onBind: (sessionId: string) => void }) {
  const waiting = new Map<string, (decided: Decided) => void>()
  const send = (message: object) => { if (port.connected) port.send!(message, () => {}) }

  const receive = (message: unknown) => {
    const bind = asBind(message)
    if (bind) {
      onBind(bind.sessionId)
      send({ type: 'routing_bound', version: 1, id: bind.id })
      return
    }
    const decided = asDecided(message)
    if (decided) waiting.get(decided.id)?.(decided)
  }
  port.on('message', receive)

  /** The host's answer to a decision; refused when it does not come in time or the turn is stopped meanwhile. */
  function decide(sessionId: string, requestId: string, plan: unknown, signal?: AbortSignal): Promise<Decided> {
    const id = randomUUID()
    return new Promise((resolve) => {
      const done = (decided: Decided) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); waiting.delete(id); resolve(decided) }
      const abort = () => done({ accepted: false, reason: '本轮已停止' })
      const timer = setTimeout(() => done({ accepted: false, reason: '应用没有及时答复这次提交' }), DECIDE_WAIT_MS)
      waiting.set(id, done)
      signal?.addEventListener('abort', abort, { once: true })
      send({ type: 'routing_decide', version: 1, id, sessionId, requestId, plan })
    })
  }

  /** What the fast lane made of an interjection, for the app's record. */
  function reportFast(sessionId: string, requestId: string, outcome: FastOutcome, reason: string | null, ms: number) {
    send({ type: 'routing_fast', version: 1, sessionId, requestId, outcome, reason, ms })
  }

  function close() {
    port.off('message', receive)
    for (const done of [...waiting.values()]) done({ accepted: false, reason: '与应用的连接已断开' })
  }

  return { decide, reportFast, close }
}
