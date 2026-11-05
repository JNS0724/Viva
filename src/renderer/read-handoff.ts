/**
 * A read of what the main process has, handed over to the live channel without a gap (system-design §12.1): while
 * it is under way, what the live channel says waits; the read is taken as the baseline, then what waited follows, in
 * order. A push the main process sent before it answered comes before the answer, but one sent after may come before
 * it too, so what came during the read is taken after it: what closed meanwhile closes again, what was asked
 * meanwhile is asked after. What is taken twice (asked before the read and also in it) has to be the same once: the
 * reducers it reaches take a request they have already shown as shown (conversation-state.ts, question-state.ts,
 * secret-state.ts). One read at a time, a few calls long: nothing is let go of meanwhile.
 */
export function createReadHandoff<E>(deliver: (event: E) => void) {
  let held: E[] | null = null

  return {
    /** An event from the main process, before it is reduced: held while a read is under way (true), else not. */
    hold(event: E): boolean {
      if (!held) return false
      held = [...held, event]
      return true
    },
    /**
     * Reads with `request`, takes what it answers (`take`), then what came meanwhile. A read that fails takes nothing
     * (`failed` is told why); what came meanwhile is taken all the same.
     */
    async read<T>(request: () => Promise<T>, take: (value: T) => void, failed: (err: unknown) => void): Promise<void> {
      held = []
      try {
        take(await request())
      } catch (err) {
        failed(err)
      } finally {
        const waited = held
        held = null
        for (const event of waited) deliver(event)
      }
    },
  }
}
