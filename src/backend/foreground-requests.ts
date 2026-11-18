/** A retained human request became invalid before native dispatch. */
export class ForegroundRequestRetired extends Error {}

type Ticket = { done: Promise<void>, current(): boolean, finish(): void }
type Report = Ticket & { ready: Promise<void>, reportIds: readonly string[], written(reportId: string): void }

/** Orders human starts against report turns; it never owns text, sessions or memory permissions. */
export function createForegroundRequests() {
  let active: Ticket | Report | null = null
  let tail: Promise<void> = Promise.resolve()
  let epoch = new AbortController()
  const waiting = new Set<object>()

  function ticket(): Ticket {
    let resolve = () => {}
    const done = new Promise<void>(release => { resolve = release })
    const own: Ticket = { done, current: () => active === own, finish() {
      if (active === own) active = null
      resolve()
    } }
    return own
  }

  return {
    lease() { const generation = epoch; return () => !generation.signal.aborted },
    busy: () => active !== null || waiting.size > 0,
    deferred: () => active !== null && 'ready' in active || waiting.size > 0,
    reportWritten(reportId: string) { if (active && 'written' in active) return active.written(reportId) },
    openingReports() { return active && 'written' in active ? active.reportIds : [] },
    reserveReport(reportIds: readonly string[]) {
      if (active || waiting.size) return null
      let started!: () => void
      const ready = new Promise<void>(resolve => { started = resolve })
      // The report is in native history before any queued interjection is offered.
      const own: Report = Object.assign(ticket(), { ready, reportIds, written(id: string) {
        if (!reportIds.includes(id)) return
        started()
      } })
      active = own
      return own
    },
    human<T>(current: () => boolean, work: (current: () => boolean) => Promise<T>,
      interject?: (held: () => boolean) => Promise<{ result: T } | null>): Promise<T> {
      const generation = epoch, marker = {}
      waiting.add(marker) // Reserve synchronously, before a report's late admission can claim the idle turn.
      const report = interject && active !== null && 'ready' in active ? active : null
      const before = Promise.all([tail, report ? Promise.race([report.ready, report.done]) : active?.done])
      const result = (async () => {
        let wake = () => {}
        const retired = new Promise<void>(resolve => { wake = resolve })
        generation.signal.addEventListener('abort', wake, { once: true })
        try {
          await Promise.race([before, retired])
          const selected = () => !generation.signal.aborted && current()
          if (report?.current() && interject && selected()) {
            const delivered = await interject(() => selected() && report.current())
            if (delivered) return delivered.result
            // Only a definite idle receipt may fall back to a new native prompt.
            await Promise.race([report.done, retired])
          }
          waiting.delete(marker)
          if (generation.signal.aborted || !current() || active) throw new ForegroundRequestRetired()
          const own = ticket()
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
