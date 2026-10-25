import path from 'node:path'
import { createFollowupNotifier, createGapWatch } from './followup-notifier.ts'
import { openFollowupStore } from './followup-store.ts'
import type { Notice } from './notice-plan.ts'

/**
 * Follow-ups, put together at launch: their store (followups.db) and the notifier that reminds at the times the
 * user agreed to and tells what is ready in the user's gaps. main.ts reports the gaps it sees (the window coming
 * back, a turn ending) and the computer waking; this watches for the user coming back after being away.
 * Launching is a waking too: reminders missed while Viva was closed go out now, merged into one.
 */
export function openFollowups({ userData, notify, windowInFront, onPending, idleSeconds }: {
  userData: string
  notify: (notice: Notice) => void
  windowInFront: () => boolean
  onPending: (count: number) => void
  /** The system's idle time (powerMonitor.getSystemIdleTime). */
  idleSeconds: () => number
}) {
  const store = openFollowupStore({ file: path.join(userData, 'followups.db') })
  const notifier = createFollowupNotifier({ store, notify, windowInFront, onPending })
  const watch = createGapWatch({ idleSeconds, onGap: notifier.gap })
  notifier.wake()
  return {
    store,
    notifier,
    close() {
      watch.stop()
      notifier.stop()
      store.close()
    },
  }
}

export type Followups = ReturnType<typeof openFollowups>
