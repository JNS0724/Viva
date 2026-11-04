import { type Apply, journaled } from './journal.ts'
import { t } from '../shared/i18n/translate.ts'
import type { DatabaseSync } from 'node:sqlite'
import type { PrepareCall, Prepared as PreparedText, ProposalView } from './followup-channel.ts'
import { createFileWatch } from './file-watch.ts'
import { createFollowupNotifier, createGapWatch } from './followup-notifier.ts'
import { openFollowupStore, type Followup, type FollowupStore } from './followup-store.ts'
import { registerFollowupsIpc } from './followups-ipc.ts'
import type { IpcRegistry } from '../shared/ipc-contract.ts'
import type { Notice } from './notice-plan.ts'
import { materialsFor, PREPARE_MAX_TOKENS, PREPARE_SYSTEM, type MaterialSources } from './prepare-materials.ts'
import { LEAD_MS, nextWindow, scheduleOf, type PrepareSchedule } from './prepare-schedule.ts'
import { createPrepareScheduler, type Prepared, type PrepareState } from './prepare-scheduler.ts'

/**
 * Follow-ups, put together at launch: their store (on the app database), the notifier that reminds at the times the
 * user agreed to and tells what is ready in the user's gaps, and background preparation, in batches at the
 * windows the user picked, read-only. main.ts reports what it sees: the window coming back and turns ending
 * (gaps), the computer waking, the user starting something (preparation yields), proposals from the model.
 */
const DECLINED_FOR_MS = 30 * 24 * 60 * 60 * 1000

interface FollowupsDeps {
  ipcMain: Pick<IpcRegistry, 'handle'>
  notify: (notice: Notice) => void
  windowInFront: () => boolean
  onPending: (count: number) => void
  /** The system's idle time (powerMonitor.getSystemIdleTime). */
  idleSeconds: () => number
  /** The 后台准备 settings, kept with the other preferences. */
  loadSchedule: () => unknown
  storeSchedule: (schedule: PrepareSchedule) => void
  /** Why the user is busy now (a turn or task of theirs going), or null. */
  userBusy: () => string | null
  /** The followups plugin's tool-less model call, on the model the user picked; null while the agent is down. */
  prepareText: (call: Omit<PrepareCall, 'provider' | 'model'>, signal: AbortSignal) => Promise<PreparedText>
  /** Whether a task of the user's already works on what came from this conversation since `since`. */
  takenUp: (conversationId: string, since: number) => boolean
  materials: Omit<MaterialSources, 'now'>
  workDir: () => string
  conversationExists: (id: string) => boolean
  /** How preparation is going, for the island and the 后台 page. */
  onState: (state: PrepareState) => void
  /** What went wrong in the background (a timer, a batch), for the log. */
  onError: (err: unknown) => void
  /** The backend's app database (src/backend/app-db.ts), which keeps the follow-ups. */
  db: DatabaseSync
  /** The event core's apply (src/backend/event-core.ts): every change of a follow-up written with its event. */
  apply: Apply
  /** The event core's signals for what comes due on its own: reminders, preparation, the user back at the computer. */
  signal?: (kind: 'clock.reminder_due' | 'clock.prepare_window' | 'system.user_returned') => void
}

/** The store's writes, each a change the event core records (apply); reads go straight through. */
const WRITES: ReadonlyArray<keyof FollowupStore & string> = Object.freeze(['add', 'setStatus', 'saveDraft', 'finishPreparing', 'moveStatus', 'markReminded', 'reschedule', 'setWatchMtime', 'rearm', 'remove', 'logNotice', 'logEvent'])
export function openFollowups(deps: FollowupsDeps) {
  const store = journaled(openFollowupStore({ db: deps.db }), 'followup', WRITES, deps.apply)
  const notifier = createFollowupNotifier({
    store, notify: deps.notify, windowInFront: deps.windowInFront, onPending: deps.onPending, onError: deps.onError,
    ...(deps.signal ? { onTimer: () => deps.signal!('clock.reminder_due') } : {}),
  })
  const schedule = () => scheduleOf(deps.loadSchedule())

  async function prepare(followup: Followup, signal: AbortSignal): Promise<Prepared> {
    const conversationId = followup.origin.conversationId
    if (conversationId && deps.takenUp(conversationId, followup.createdAt)) {
      return { skip: t("main.followups-main.you.already.started.a.background.task.from") }
    }
    const { input, readFiles } = materialsFor(followup, deps.materials)
    const result = await deps.prepareText({ system: PREPARE_SYSTEM, input, maxTokens: PREPARE_MAX_TOKENS, requireComplete: true }, signal)
    return result.ok ? { ok: true, draft: result.text, readFiles } : { ok: false, problem: result.problem, ...(result.called === false ? { called: false } : {}) }
  }

  const scheduler = createPrepareScheduler({
    store,
    schedule,
    busy: deps.userBusy,
    prepare,
    onState: deps.onState,
    onReady: () => notifier.refresh(),
    onError: deps.onError,
    ...(deps.signal ? { onTimer: () => deps.signal!('clock.prepare_window') } : {}),
  })
  const watch = createGapWatch({ idleSeconds: deps.idleSeconds, onGap: deps.signal ? () => deps.signal!('system.user_returned') : notifier.gap, onError: deps.onError })
  // A file the user named changed and settled: prepared again in the next window.
  const files = createFileWatch({
    store,
    onError: deps.onError,
    onChanged: (followup) => {
      const at = Date.now()
      store.rearm(followup.id, (nextWindow(at, schedule()) ?? at) + LEAD_MS, at)
      store.logEvent('file_changed', { id: followup.id })
      scheduler.refresh()
      notifier.refresh()
    },
  })
  registerFollowupsIpc(deps.ipcMain, {
    store,
    scheduler,
    changed: () => notifier.refresh(),
    schedule,
    saveSchedule: deps.storeSchedule,
    workDir: deps.workDir,
    conversationExists: deps.conversationExists,
  })

  /** Whether the user turned this down lately, or asked not to be asked about such things again. */
  function declined(proposal: ProposalView): boolean {
    const since = Date.now() - DECLINED_FOR_MS
    return store.declinedSince(since).some((title) => title === proposal.title)
  }

  notifier.wake()
  scheduler.start()

  return {
    store,
    notifier,
    scheduler,
    /** A proposal from the model, to show on a card; null when the user turned the same down lately. */
    admitProposal(proposal: ProposalView): ProposalView | null {
      if (declined(proposal)) return null
      store.logEvent('suggest_shown', { title: proposal.title, from: 'chat' })
      return proposal
    },
    /** A gap of the user's: what is ready may be told, and preparation that waited on them looks again. */
    gap() {
      notifier.gap()
      scheduler.refresh()
    },
    close() {
      files.stop()
      watch.stop()
      scheduler.stop()
      notifier.stop()
      store.close()
    },
  }
}

export type Followups = ReturnType<typeof openFollowups>
