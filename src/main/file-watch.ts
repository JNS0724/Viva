import fs from 'node:fs'
import type { Followup, FollowupStore } from './followup-store.ts'

/**
 * Files the user named (「这个文件变了就帮我……」): once one has changed and then stayed as it is for 10 minutes
 * (the user is done with it), its follow-up is prepared again in the next window. Asked of the file's change
 * time once a minute rather than through file system events, which differ between systems (and miss changes on
 * some Windows and network drives). A follow-up keeps watching until it is dismissed.
 */
const MINUTE_MS = 60_000
export const SETTLE_MS = 10 * MINUTE_MS
const POLL_MS = MINUTE_MS

type Repeat = ReturnType<typeof setInterval>

export interface FileWatchDeps {
  store: Pick<FollowupStore, 'list' | 'setWatchMtime'>
  /** The file changed and settled: prepare its follow-up again. */
  onChanged: (followup: Followup) => void
  /** The file's change time, or null when it cannot be read (moved, deleted, offline). */
  mtimeOf?: (file: string) => number | null
  now?: () => number
  setRepeat?: (fn: () => void, ms: number) => Repeat
  clearRepeat?: (handle: Repeat) => void
}

const statMtime = (file: string): number | null => {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return null
  }
}

export function createFileWatch(deps: FileWatchDeps) {
  const { store, onChanged, mtimeOf = statMtime, now = Date.now, setRepeat = setInterval, clearRepeat = clearInterval } = deps
  /** Changes seen and not settled yet: the change time seen, and since when it has stayed so. */
  const settling = new Map<string, { mtime: number, since: number }>()

  /** One look at every watched file. */
  function check() {
    const watched = store.list().filter((f) => f.watchPath && f.status !== 'dismissed')
    const ids = new Set(watched.map((f) => f.id))
    for (const id of [...settling.keys()]) if (!ids.has(id)) settling.delete(id)
    for (const followup of watched) {
      const mtime = mtimeOf(followup.watchPath as string)
      if (mtime === null) continue
      if (followup.watchMtime === null) {
        store.setWatchMtime(followup.id, mtime)
        continue
      }
      if (mtime === followup.watchMtime) {
        settling.delete(followup.id)
        continue
      }
      const seen = settling.get(followup.id)
      if (!seen || seen.mtime !== mtime) {
        settling.set(followup.id, { mtime, since: now() })
        continue
      }
      if (now() - seen.since < SETTLE_MS) continue
      settling.delete(followup.id)
      store.setWatchMtime(followup.id, mtime)
      onChanged(followup)
    }
  }

  const handle = setRepeat(check, POLL_MS)
  return { check, stop: () => clearRepeat(handle) }
}
