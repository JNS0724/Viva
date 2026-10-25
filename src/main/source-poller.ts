import type { SourceFolder } from './source-folders.ts'
import type { Ran } from './source-run.ts'
import type { ConfigValues, PollResult } from './source-contract.ts'
import type { SourcesDb } from './sources-db.ts'
import type { SourceSettingsStore } from './source-settings.ts'

/**
 * Asks each switched-on source for new messages every so often, one run at a time per source. Settings are read
 * afresh at every run, so a change in settings applies at the next one; `refresh` after a change reschedules
 * (switched on: soon; off: never again; another interval: from the last run). After a failure the source is
 * asked again later and later (1, 5, 15, 60 minutes, never sooner than its own interval), from the same place.
 */
const MINUTE = 60_000
export const BACKOFF_MINUTES = Object.freeze([1, 5, 15, 60])
/** Sources switched on at launch start a little after it, one after another, not all at once. */
const FIRST_DELAY_MS = 5_000
const STAGGER_MS = 2_000

type Timer = ReturnType<typeof setTimeout>
type Poll = (folder: SourceFolder, config: ConfigValues, cursor: string | null) => Promise<Ran<PollResult>>

interface Slot { timer: Timer | null, everyMinutes: number, lastRunAt: number | null, running: boolean }

export interface PollerDeps {
  folders: () => SourceFolder[]
  settings: Pick<SourceSettingsStore, 'get'>
  db: Pick<SourcesDb, 'save' | 'fail' | 'cursorOf'>
  poll: Poll
  /** Told after each run, so an open settings page can show it. */
  onRun?: (id: string, outcome: { added: number } | { problem: string }) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => Timer
  clearTimer?: (timer: Timer) => void
}

/** How long to wait after `failures` failures in a row, for a source asked every `everyMinutes`. */
export function retryDelayMs(failures: number, everyMinutes: number): number {
  const backoff = BACKOFF_MINUTES[Math.min(failures, BACKOFF_MINUTES.length) - 1] ?? everyMinutes
  return Math.max(backoff, everyMinutes) * MINUTE
}

export function createSourcePoller(deps: PollerDeps) {
  const { folders, settings, db, poll, onRun = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = deps
  const slots = new Map<string, Slot>()
  let stopped = false

  const folderOf = (id: string) => folders().find((folder) => folder.manifest.id === id)

  function schedule(id: string, ms: number) {
    const slot = slots.get(id)
    if (!slot || stopped) return
    if (slot.timer) clearTimer(slot.timer)
    slot.timer = setTimer(() => {
      slot.timer = null
      void runOnce(id)
    }, Math.max(0, ms))
  }

  function failed(id: string, slot: Slot, problem: string) {
    const failures = db.fail(id, problem)
    onRun(id, { problem })
    schedule(id, retryDelayMs(failures, slot.everyMinutes))
  }

  /** One poll of `id` with its settings as they are now; schedules the next. */
  async function runOnce(id: string): Promise<void> {
    const slot = slots.get(id)
    const folder = folderOf(id)
    if (!slot || !folder || slot.running) return
    const current = settings.get(folder.manifest)
    if (!current.enabled) return
    slot.running = true
    slot.lastRunAt = now()
    try {
      const ran = await poll(folder, current.values, db.cursorOf(id))
      // Switched off or removed while it ran: what it read is let go.
      if (!slots.has(id) || !settings.get(folder.manifest).enabled) return
      if (!ran.ok) return failed(id, slot, ran.problem)
      const added = db.save(id, ran.value.messages, ran.value.cursor, ran.value.dropped)
      onRun(id, { added })
      schedule(id, slot.everyMinutes * MINUTE)
    } catch (err) {
      if (slots.has(id)) failed(id, slot, err instanceof Error ? err.message : String(err))
    } finally {
      slot.running = false
    }
  }

  function drop(id: string) {
    const slot = slots.get(id)
    if (slot?.timer) clearTimer(slot.timer)
    slots.delete(id)
  }

  /** Brings the schedule in line with the folders and settings as they are now. */
  function refresh({ launching = false }: { launching?: boolean } = {}) {
    if (stopped) return
    const enabled = folders().flatMap((folder) => {
      const current = settings.get(folder.manifest)
      return current.enabled ? [{ id: folder.manifest.id, everyMinutes: current.everyMinutes }] : []
    })
    const ids = new Set(enabled.map((source) => source.id))
    for (const id of [...slots.keys()]) if (!ids.has(id)) drop(id)
    enabled.forEach(({ id, everyMinutes }, index) => {
      const slot = slots.get(id)
      if (!slot) {
        slots.set(id, { timer: null, everyMinutes, lastRunAt: null, running: false })
        // Just switched on: read now, so whoever asks next already sees it running.
        if (launching) schedule(id, FIRST_DELAY_MS + index * STAGGER_MS)
        else void runOnce(id)
        return
      }
      if (slot.everyMinutes === everyMinutes) return
      slot.everyMinutes = everyMinutes
      if (!slot.running) schedule(id, slot.lastRunAt === null ? 0 : slot.lastRunAt + everyMinutes * MINUTE - now())
    })
  }

  /** 现在拉一次: runs now unless it is already running; the regular schedule goes on from this run. */
  async function pollNow(id: string): Promise<void> {
    const slot = slots.get(id)
    if (!slot) return
    if (slot.timer) clearTimer(slot.timer)
    slot.timer = null
    await runOnce(id)
  }

  function stop() {
    stopped = true
    for (const id of [...slots.keys()]) drop(id)
  }

  return { refresh, pollNow, stop, isRunning: (id: string) => slots.get(id)?.running === true }
}

export type SourcePoller = ReturnType<typeof createSourcePoller>
