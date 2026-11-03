import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs'
import path from 'node:path'
import type { Followup, FollowupStore } from './followup-store.ts'
import { weekStats } from './followup-stats.ts'
import { handlerOf, type IpcRegistry } from './ipc-contract.ts'
import { changedSince } from './prepare-materials.ts'
import { checkSchedule, nextWindow, type PrepareSchedule } from './prepare-schedule.ts'
import type { PrepareScheduler } from './prepare-scheduler.ts'

/**
 * IPC for follow-ups: the card's 跟进 / 不用 (a follow-up is made only here, on the user's yes, with the times
 * checked and shown), the 后台 page's follow-ups (接着做 hands the draft to the conversation, 不用了 lets it go,
 * 现在就准备 does not wait for a window, 叫醒它 stops a preparation), and the 后台准备 settings.
 */
const MINUTE_MS = 60_000
const WEEK_MS = 7 * 24 * 60 * MINUTE_MS
/** A time a little in the past still counts (the card sat there a moment). */
const PAST_SLACK_MS = MINUTE_MS
const MAX_PAUSE_MINUTES = 24 * 60
const MAX_FIELD_CHARS = 2000
const MAX_TITLE_CHARS = 60
const MAX_TIME_CHARS = 60
const MAX_PATH_CHARS = 1000
const MAX_FILES = 5

export interface FollowupsIpcDeps {
  store: FollowupStore
  scheduler: Pick<PrepareScheduler, 'refresh' | 'prepareNow' | 'wakeUp' | 'state'> & Partial<Pick<PrepareScheduler, 'abandon'>>
  /** After a change: the timer for reminders, the tray's count. */
  changed: () => void
  schedule: () => PrepareSchedule
  saveSchedule: (schedule: PrepareSchedule) => void
  /** The conversation's folder, against which files named without a full path are read. */
  workDir: () => string
  conversationExists: (id: string) => boolean
  now?: () => number
}

const text = (value: unknown, what: string, max = MAX_FIELD_CHARS): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(t("main.followups-ipc.invalid", { what: what }))
  return value.trim()
}

/** An ISO time from the card, as ms; null when not given. Times in the past are refused. */
function timeOf(value: unknown, what: string, now: number): number | null {
  if (value === null || value === undefined || value === '') return null
  const at = Date.parse(text(value, what, MAX_TIME_CHARS))
  if (!Number.isFinite(at)) throw new Error(t("main.followups-ipc.is.not.a.valid.time", { what: what }))
  if (at < now - PAST_SLACK_MS) throw new Error(t("main.followups-ipc.has.already.passed", { what: what }))
  return at
}

/** A follow-up as the 后台 page shows it. */
function followupView(followup: Followup) {
  return {
    id: followup.id,
    title: followup.title,
    ask: followup.ask,
    status: followup.status,
    origin: followup.origin.kind,
    remindAt: followup.remindAt,
    prepareBy: followup.prepareBy,
    files: followup.files.map((file) => path.basename(file)),
    watching: followup.watchPath ? path.basename(followup.watchPath) : null,
    draft: followup.draft,
    draftAt: followup.draftAt,
    lateFrom: followup.lateFrom,
    createdAt: followup.createdAt,
  }
}

/** What 接着做 puts in the input: the follow-up and its draft, and the files changed since, to be read again. */
function continueText(followup: Followup): string {
  const changed = changedSince(followup.readFiles)
  return [
    t("main.followups-ipc.continue", { title: followup.title, ask: followup.ask }),
    followup.draft ? t("main.followups-ipc.draft.prepared.in.the.background", { draft: followup.draft }) : '',
    changed.length ? t("main.followups-ipc.these.files.changed.after.preparation.read.them", { value1: changed.join('、') }) : '',
  ].join('')
}

export function registerFollowupsIpc(ipcMain: Pick<IpcRegistry, 'handle'>, deps: FollowupsIpcDeps) {
  const handle = handlerOf(ipcMain)
  const now = deps.now ?? Date.now

  const view = () => {
    const at = now()
    const plan = deps.schedule()
    return {
      followups: deps.store.list().map(followupView),
      schedule: plan,
      nextWindow: nextWindow(at, plan),
      state: deps.scheduler.state(),
      callsToday: deps.store.countEvents('prepare_call', new Date(at).setHours(0, 0, 0, 0)),
      lateThisWeek: deps.store.countEvents('prepare_late', at - WEEK_MS),
      week: weekStats(deps.store.eventsSince(at - WEEK_MS), at),
    }
  }

  const afterChange = () => {
    deps.changed()
    deps.scheduler.refresh()
    return view()
  }

  const existing = (id: string) => {
    const followup = deps.store.get(id)
    if (!followup) throw new Error(t("main.followups-ipc.this.follow.up.is.no.longer.available"))
    return followup
  }

  handle('followups:get', view)

  /** 跟进 on a card: the follow-up made, its times checked; the first one that needs preparing asks for windows. */
  handle('followups:accept', (input) => {
    const at = now()
    const title = text(input.title, t("main.followups-ipc.title"), MAX_TITLE_CHARS)
    const ask = text(input.ask, t("main.followups-ipc.task.description"))
    const remindAt = timeOf(input.remindAt, t("main.followups-ipc.reminder.time"), at)
    const prepareBy = timeOf(input.prepareBy, t("main.followups-ipc.preparation.time"), at)
    const named = Array.isArray(input.files) ? input.files.slice(0, MAX_FILES) : []
    const files = named.map((file: unknown) => path.resolve(deps.workDir(), text(file, t("main.followups-ipc.files"), MAX_PATH_CHARS)))
    const watchPath = input.watchFile ? path.resolve(deps.workDir(), text(input.watchFile, t("main.followups-ipc.watched.file"), MAX_PATH_CHARS)) : null
    if (watchPath && !fs.existsSync(watchPath)) throw new Error(t("main.followups-ipc.watched.file.not.found", { watchPath: watchPath }))
    const conversationId = typeof input.conversationId === 'string' && deps.conversationExists(input.conversationId) ? input.conversationId : undefined
    const followup = deps.store.add({ title, ask, origin: { kind: 'chat', ...(conversationId ? { conversationId } : {}) }, remindAt, prepareBy, files, watchPath })
    // Its change time as it is now: what changes from here starts a preparation.
    if (watchPath) deps.store.setWatchMtime(followup.id, fs.statSync(watchPath).mtimeMs)
    deps.store.logEvent('suggest_accepted', { id: followup.id })
    return { ...afterChange(), accepted: followupView(followup), chooseWindows: prepareBy !== null && !deps.schedule().chosen }
  })

  /** 不用 on a card: the same thing is not proposed again for 30 days (followups-main.ts admitProposal). */
  handle('followups:decline', (input) => {
    deps.store.logEvent('suggest_declined', { title: text(input.title, t("main.followups-ipc.title"), MAX_TITLE_CHARS), never: input.never === true })
    return view()
  })

  handle('followups:dismiss', (id) => {
    existing(id)
    deps.store.setStatus(id, 'dismissed')
    deps.scheduler.abandon?.(id)
    deps.store.logEvent('followup_dismissed', { id })
    return afterChange()
  })

  /**
   * 接着做: what to put in the input; the follow-up is done once handed over, or, watching a file, waits for its
   * next change.
   */
  handle('followups:continue', (id) => {
    const followup = existing(id)
    deps.scheduler.abandon?.(id)
    if (followup.watchPath) {
      deps.store.reschedule(id, { prepareBy: null })
      deps.store.setStatus(id, 'scheduled')
    } else deps.store.setStatus(id, 'done')
    deps.store.logEvent('followup_continued', { id, prepared: followup.draft !== null })
    return { ...afterChange(), text: continueText(followup) }
  })

  handle('followups:prepare-now', (id) => {
    if (existing(id).status !== 'scheduled') throw new Error(t("main.followups-ipc.this.item.has.already.been.prepared"))
    deps.scheduler.prepareNow(id)
    return view()
  })

  handle('followups:wake', () => {
    deps.scheduler.wakeUp()
    return view()
  })

  handle('followups:set-schedule', (input) => {
    deps.saveSchedule(checkSchedule({ ...deps.schedule(), ...input, chosen: true }))
    return afterChange()
  })

  /** From the tray or settings: no preparation for a while (0: go on). */
  handle('followups:pause', (minutes) => {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_PAUSE_MINUTES) throw new Error(t("main.followups-ipc.invalid.pause.duration"))
    deps.saveSchedule({ ...deps.schedule(), pausedUntil: minutes ? now() + minutes * MINUTE_MS : null })
    return afterChange()
  })
}

