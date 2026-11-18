import { belongsTo, contextOf, isConversationEvent, type ContextEvent, type ConversationContext } from '../shared/conversation-context.ts'

/** Hold foreground pushes until the page has committed its selection; task streams remain independent. */
export function createConversationIngress<Event extends ContextEvent>({ current, deliver, microtask = queueMicrotask, now = Date.now, initialized = true, overflow,
  maxEvents = 1024, maxBytes = 2 * 1024 * 1024, maxAgeMs = 15_000,
}: {
  current: () => { pending: boolean, context: ConversationContext }
  deliver: (event: Event, receivedAt: number) => void
  microtask?: (run: () => void) => void
  now?: () => number
  initialized?: boolean
  overflow?: (reason: 'capacity' | 'age') => void
  maxEvents?: number, maxBytes?: number, maxAgeMs?: number
}) {
  let held: Array<{ json: string, receivedAt: number, bytes: number }> = [], scheduled = false, draining = false
  let heldBytes = 0, failed = false, ageTimer: ReturnType<typeof setTimeout> | undefined
  const pending = () => !initialized || current().pending
  function clear() { held = []; heldBytes = 0; clearTimeout(ageTimer); ageTimer = undefined }
  function fail(reason: 'capacity' | 'age') { failed = true; initialized = false; clear(); overflow?.(reason) }
  function age() {
    clearTimeout(ageTimer); ageTimer = undefined
    if (!overflow || !held.length) return
    const remaining = held[0]!.receivedAt + maxAgeMs - now()
    if (remaining <= 0) { fail('age'); return }
    ageTimer = setTimeout(age, remaining)
  }

  function stateChanged() {
    if (scheduled || draining || !held.length || pending()) return
    scheduled = true
    microtask(() => {
      scheduled = false
      if (pending()) return
      draining = true
      try {
        while (held.length && !pending()) {
          const { json, receivedAt, bytes } = held.shift()!
          const event = JSON.parse(json) as Event
          heldBytes -= bytes
          if (belongsTo(event, current().context)) deliver(event, receivedAt)
        }
      } finally { draining = false; age(); stateChanged() }
    })
  }

  function receive(event: Event) {
    const receivedAt = now()
    if (!isConversationEvent(event)) return deliver(event, receivedAt)
    if (failed) return
    const view = current(), origin = contextOf(event)
    // Unattributed legacy pushes cannot prove they belong to a pending topic.
    if (!origin) { if (!pending()) deliver(event, receivedAt); return }
    if (pending() || draining || held.length) {
      let bytes: number, json: string
      try { json = JSON.stringify(event); bytes = Math.max(json.length * 2, new TextEncoder().encode(json).byteLength) + 128 } catch { fail('capacity'); return }
      if (held.length + 1 > maxEvents || heldBytes + bytes > maxBytes) { fail('capacity'); return }
      held.push({ json, receivedAt, bytes }); heldBytes += bytes; age(); stateChanged(); return
    }
    if (belongsTo(event, view.context)) deliver(event, receivedAt)
  }

  return {
    receive, stateChanged, initialize() { initialized = true; failed = false; stateChanged() },
    pause() { initialized = false; failed = false; clear() },
    settled: () => initialized && !pending() && !held.length && !draining,
    reviseHeld(project: (event: Event) => Event | undefined) {
      held = held.flatMap(item => {
        const event = project(JSON.parse(item.json) as Event)
        if (event === undefined) return []
        const json = JSON.stringify(event)
        return [{ ...item, json, bytes: Math.max(json.length * 2, new TextEncoder().encode(json).byteLength) + 128 }]
      })
      heldBytes = held.reduce((sum, item) => sum + item.bytes, 0)
      if (heldBytes > maxBytes) fail('capacity')
      else age()
    },
  }
}
