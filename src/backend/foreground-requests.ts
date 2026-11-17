/** A retained human request became invalid before native dispatch. */
export class ForegroundRequestRetired extends Error {}

type Ticket = { kind: 'human' | 'report', done: Promise<void>, current(): boolean, finish(): void }

/** Orders human starts against report turns; it never owns text, sessions or memory permissions. */
export function createForegroundRequests() {
  let active: Ticket | null = null
  let tail: Promise<void> = Promise.resolve()
  let epoch = new AbortController()
  const waiting = new Set<object>()

  function ticket(kind: Ticket['kind']): Ticket {
    let resolve = () => {}
    const done = new Promise<void>(release => { resolve = release })
    const own: Ticket = { kind, done, current: () => active === own, finish() {
      if (active === own) active = null
      resolve()
    } }
    return own
  }

  return {
    lease() { const generation = epoch; return () => !generation.signal.aborted },
    busy: () => active !== null || waiting.size > 0,
    deferred: () => active?.kind === 'report' || waiting.size > 0,
    reserveReport() {
      if (active || waiting.size) return null
      const own = ticket('report')
      active = own
      return own
    },
    human<T>(current: () => boolean, work: (current: () => boolean) => Promise<T>): Promise<T> {
      const generation = epoch, marker = {}
      const before = Promise.all([tail, active?.done])
      waiting.add(marker) // Reserve synchronously, before a report's late admission can claim the idle turn.
      const result = (async () => {
        let wake = () => {}
        const retired = new Promise<void>(resolve => { wake = resolve })
        generation.signal.addEventListener('abort', wake, { once: true })
        try {
          await Promise.race([before, retired])
          waiting.delete(marker)
          if (generation.signal.aborted || !current() || active) throw new ForegroundRequestRetired()
          const own = ticket('human')
          active = own
          const held = () => !generation.signal.aborted && active === own && current()
          try { return await work(held) } finally { own.finish() }
        } finally {
          waiting.delete(marker)
          generation.signal.removeEventListener('abort', wake)
        }
      })()
      tail = result.then(() => {}, () => {})
      return result
    },
    invalidate() {
      const previous = epoch
      epoch = new AbortController()
      active?.finish()
      waiting.clear()
      tail = Promise.resolve()
      previous.abort()
    },
  }
}
