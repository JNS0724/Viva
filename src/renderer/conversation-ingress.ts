import { belongsTo, contextOf, isConversationEvent, type ContextEvent, type ConversationContext } from '../shared/conversation-context.ts'

/** Hold foreground pushes until the page has committed its selection; task streams remain independent. */
export function createConversationIngress<Event extends ContextEvent>({ current, deliver, microtask = queueMicrotask, now = Date.now, initialized = true }: {
  current: () => { pending: boolean, context: ConversationContext }
  deliver: (event: Event, receivedAt: number) => void
  microtask?: (run: () => void) => void
  now?: () => number
  initialized?: boolean
}) {
  let held: Array<{ event: Event, receivedAt: number }> = [], scheduled = false, draining = false
  const pending = () => !initialized || current().pending

  function stateChanged() {
    if (scheduled || draining || !held.length || pending()) return
    scheduled = true
    microtask(() => {
      scheduled = false
      if (pending()) return
      draining = true
      try {
        while (held.length && !pending()) {
          const { event, receivedAt } = held.shift()!
          if (belongsTo(event, current().context)) deliver(event, receivedAt)
        }
      } finally { draining = false; stateChanged() }
    })
  }

  function receive(event: Event) {
    const receivedAt = now()
    if (!isConversationEvent(event)) return deliver(event, receivedAt)
    const view = current(), origin = contextOf(event)
    // Unattributed legacy pushes cannot prove they belong to a pending topic.
    if (!origin) { if (!pending()) deliver(event, receivedAt); return }
    if (pending() || draining || held.length) {
      held.push({ event, receivedAt }); stateChanged(); return
    }
    if (belongsTo(event, view.context)) deliver(event, receivedAt)
  }

  return { receive, stateChanged, initialize() { initialized = true; stateChanged() } }
}
