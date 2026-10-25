import path from 'node:path'
import type { PrepareCall, Prepared as PreparedText, ProposalView } from './followup-channel.ts'
import { createFollowupNotifier, createGapWatch } from './followup-notifier.ts'
import { openFollowupStore, type Followup } from './followup-store.ts'
import { registerFollowupsIpc } from './followups-ipc.ts'
import type { IpcRegistry } from './ipc-contract.ts'
import { createMessageJudge, type JudgeDeps } from './message-judge.ts'
import type { Notice } from './notice-plan.ts'
import { materialsFor, PREPARE_MAX_TOKENS, PREPARE_SYSTEM, type MaterialSources } from './prepare-materials.ts'
import { scheduleOf, type PrepareSchedule } from './prepare-schedule.ts'
import { createPrepareScheduler, type Prepared, type PrepareState } from './prepare-scheduler.ts'

/**
 * Follow-ups, put together at launch: their store (followups.db), the notifier that reminds at the times the
 * user agreed to and tells what is ready in the user's gaps, and background preparation, in batches at the
 * windows the user picked, read-only, judging the sources' new messages first. main.ts reports what it sees: the
 * window coming back and turns ending (gaps), the computer waking, the user starting something (preparation
 * yields), proposals from the model, new messages.
 */
const DECLINED_FOR_MS = 30 * 24 * 60 * 60 * 1000

export interface FollowupsDeps {
  userData: string
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
  materials: Omit<MaterialSources, 'now' | 'message'>
  /** The sources' messages (sources-db.ts), to judge and to prepare from; none without sources. */
  messages?: JudgeDeps['sources'] & { message: NonNullable<MaterialSources['message']> }
  workDir: () => string
  conversationExists: (id: string) => boolean
  /** How preparation is going, for the island and the 后台 page. */
  onState: (state: PrepareState) => void
}

export function openFollowups(deps: FollowupsDeps) {
  const store = openFollowupStore({ file: path.join(deps.userData, 'followups.db') })
  const notifier = createFollowupNotifier({ store, notify: deps.notify, windowInFront: deps.windowInFront, onPending: deps.onPending })
  const schedule = () => scheduleOf(deps.loadSchedule())

  async function prepare(followup: Followup, signal: AbortSignal): Promise<Prepared> {
    const conversationId = followup.origin.conversationId
    if (conversationId && deps.takenUp(conversationId, followup.createdAt)) {
      return { skip: '你已经从那段对话开了后台任务在做这件事，这里不再重复准备。' }
    }
    const { input, readFiles } = materialsFor(followup, { ...deps.materials, message: deps.messages?.message })
    const result = await deps.prepareText({ system: PREPARE_SYSTEM, input, maxTokens: PREPARE_MAX_TOKENS }, signal)
    return result.ok ? { ok: true, draft: result.text, readFiles } : { ok: false, problem: result.problem }
  }

  const judge = deps.messages
    ? createMessageJudge({ sources: deps.messages, store, prepareText: deps.prepareText, profile: deps.materials.profile })
    : undefined
  const scheduler = createPrepareScheduler({
    store,
    schedule,
    busy: deps.userBusy,
    prepare,
    judge,
    onState: deps.onState,
    onReady: () => notifier.refresh(),
  })
  const watch = createGapWatch({ idleSeconds: deps.idleSeconds, onGap: notifier.gap })
  registerFollowupsIpc(deps.ipcMain, {
    store,
    scheduler,
    changed: () => notifier.refresh(),
    schedule,
    saveSchedule: deps.storeSchedule,
    workDir: deps.workDir,
    conversationExists: deps.conversationExists,
    message: deps.messages?.message,
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
      watch.stop()
      scheduler.stop()
      notifier.stop()
      store.close()
    },
  }
}

export type Followups = ReturnType<typeof openFollowups>
