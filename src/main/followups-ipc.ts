import path from 'node:path'
import type { Followup, FollowupStore, Suggestion } from './followup-store.ts'
import { handlerOf, type IpcRegistry } from './ipc-contract.ts'
import { changedSince } from './prepare-materials.ts'
import { checkSchedule, nextWindow, type PrepareSchedule } from './prepare-schedule.ts'
import type { PrepareScheduler } from './prepare-scheduler.ts'

/**
 * IPC for follow-ups: the card's 跟进 / 不用 (a follow-up is made only here, on the user's yes, with the times
 * checked and shown), the 后台 page's follow-ups (接着做 hands the draft to the conversation, 不用了 lets it go,
 * 现在就准备 does not wait for a window, 叫醒它 stops a preparation), messages suggested for a follow-up (跟进 makes
 * one from the message; 不重要 and 以后别问这类 are learnt), and the 后台准备 settings.
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
/** A message followed up on without a time of its own is prepared at the next quiet moment. */
const SOON_MS = 60 * MINUTE_MS
const PREVIEW_CHARS = 400
const SUGGESTION_ACTIONS = new Set(['accept', 'decline', 'never'])

export interface FollowupsIpcDeps {
  store: FollowupStore
  scheduler: Pick<PrepareScheduler, 'refresh' | 'prepareNow' | 'wakeUp' | 'state'>
  /** After a change: the timer for reminders, the tray's count. */
  changed: () => void
  schedule: () => PrepareSchedule
  saveSchedule: (schedule: PrepareSchedule) => void
  /** The conversation's folder, against which files named without a full path are read. */
  workDir: () => string
  conversationExists: (id: string) => boolean
  /** The message a suggestion is about, from the sources; null once gone. */
  message?: (source: string, id: string) => { from?: string, title?: string, text?: string, at: number } | null
  now?: () => number
}

const text = (value: unknown, what: string, max = MAX_FIELD_CHARS): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${what}不对`)
  return value.trim()
}

/** An ISO time from the card, as ms; null when not given. Times in the past are refused. */
function timeOf(value: unknown, what: string, now: number): number | null {
  if (value === null || value === undefined || value === '') return null
  const at = Date.parse(text(value, what, MAX_TIME_CHARS))
  if (!Number.isFinite(at)) throw new Error(`${what}不是有效的时间`)
  if (at < now - PAST_SLACK_MS) throw new Error(`${what}已经过了`)
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
    draft: followup.draft,
    draftAt: followup.draftAt,
    lateFrom: followup.lateFrom,
    createdAt: followup.createdAt,
  }
}

/** A suggestion as the 后台 page shows it: the message it is about, why, and what following up would do. */
function suggestionView(suggestion: Suggestion, message: FollowupsIpcDeps['message']) {
  const found = message?.(suggestion.source, suggestion.messageId) ?? null
  return {
    id: suggestion.id,
    title: suggestion.title,
    ask: suggestion.ask,
    why: suggestion.why,
    remindAt: suggestion.remindAt,
    status: suggestion.status,
    createdAt: suggestion.createdAt,
    sender: suggestion.sender,
    message: found ? { from: found.from ?? '', title: found.title ?? '', text: (found.text ?? '').slice(0, PREVIEW_CHARS), at: found.at } : null,
  }
}

/** What 接着做 puts in the input: the follow-up and its draft, and the files changed since, to be read again. */
function continueText(followup: Followup): string {
  const changed = changedSince(followup.readFiles)
  return [
    `接着做「${followup.title}」：${followup.ask}`,
    followup.draft ? `\n\n后台准备好的草稿：\n\n${followup.draft}` : '',
    changed.length ? `\n\n（这些文件在准备之后改过，请重新读：${changed.join('、')}）` : '',
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
      suggestions: deps.store.listSuggestions().map((suggestion) => suggestionView(suggestion, deps.message)),
      schedule: plan,
      nextWindow: nextWindow(at, plan),
      state: deps.scheduler.state(),
      callsToday: deps.store.countEvents('prepare_call', new Date(at).setHours(0, 0, 0, 0)),
      lateThisWeek: deps.store.countEvents('prepare_late', at - WEEK_MS),
    }
  }

  const afterChange = () => {
    deps.changed()
    deps.scheduler.refresh()
    return view()
  }

  const existing = (id: string) => {
    const followup = deps.store.get(id)
    if (!followup) throw new Error('这条跟进已经不在了')
    return followup
  }

  handle('followups:get', view)

  /** 跟进 on a card: the follow-up made, its times checked; the first one that needs preparing asks for windows. */
  handle('followups:accept', (input) => {
    const at = now()
    const title = text(input.title, '标题', MAX_TITLE_CHARS)
    const ask = text(input.ask, '要做的事')
    const remindAt = timeOf(input.remindAt, '提醒时间', at)
    const prepareBy = timeOf(input.prepareBy, '准备时间', at)
    const named = Array.isArray(input.files) ? input.files.slice(0, MAX_FILES) : []
    const files = named.map((file: unknown) => path.resolve(deps.workDir(), text(file, '文件', MAX_PATH_CHARS)))
    const conversationId = typeof input.conversationId === 'string' && deps.conversationExists(input.conversationId) ? input.conversationId : undefined
    const followup = deps.store.add({ title, ask, origin: { kind: 'chat', ...(conversationId ? { conversationId } : {}) }, remindAt, prepareBy, files })
    deps.store.logEvent('suggest_accepted', { id: followup.id })
    return { ...afterChange(), accepted: followupView(followup), chooseWindows: prepareBy !== null && !deps.schedule().chosen }
  })

  /** 不用 on a card: the same thing is not proposed again for 30 days (followups-main.ts admitProposal). */
  handle('followups:decline', (input) => {
    deps.store.logEvent('suggest_declined', { title: text(input.title, '标题', MAX_TITLE_CHARS), never: input.never === true })
    return view()
  })

  handle('followups:dismiss', (id) => {
    existing(id)
    deps.store.setStatus(id, 'dismissed')
    deps.store.logEvent('followup_dismissed', { id })
    return afterChange()
  })

  /** 接着做: what to put in the input; the follow-up is done once handed over. */
  handle('followups:continue', (id) => {
    const followup = existing(id)
    deps.store.setStatus(id, 'done')
    deps.store.logEvent('followup_continued', { id, prepared: followup.draft !== null })
    return { ...afterChange(), text: continueText(followup) }
  })

  handle('followups:prepare-now', (id) => {
    if (existing(id).status !== 'scheduled') throw new Error('这条已经准备过了')
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

  /**
   * A message suggested for a follow-up: 跟进 makes one (prepared before its time, or soon when it has none);
   * 不重要 counts against its sender (twice, and they are not suggested again); 以后别问这类 mutes them at once.
   */
  handle('followups:suggestion', (id, action) => {
    const suggestion = deps.store.getSuggestion(id)
    if (!suggestion || suggestion.status !== 'open') throw new Error('这条建议已经处理过了')
    if (!SUGGESTION_ACTIONS.has(action)) throw new Error('不认识的操作')
    if (action !== 'accept') {
      deps.store.settleSuggestion(id, action === 'never' ? 'never' : 'declined')
      deps.store.logEvent('suggest_declined', { from: 'message', never: action === 'never' })
      return afterChange()
    }
    const followup = deps.store.add({
      title: suggestion.title,
      ask: suggestion.ask,
      origin: { kind: 'message', sourceId: suggestion.source, messageId: suggestion.messageId },
      remindAt: suggestion.remindAt,
      prepareBy: suggestion.remindAt ?? now() + SOON_MS,
    })
    deps.store.settleSuggestion(id, 'accepted', followup.id)
    deps.store.logEvent('suggest_accepted', { id: followup.id, from: 'message' })
    return { ...afterChange(), accepted: followupView(followup), chooseWindows: !deps.schedule().chosen }
  })

  /** From the tray or settings: no preparation for a while (0: go on). */
  handle('followups:pause', (minutes) => {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_PAUSE_MINUTES) throw new Error('暂停时间不对')
    deps.saveSchedule({ ...deps.schedule(), pausedUntil: minutes ? now() + minutes * MINUTE_MS : null })
    return afterChange()
  })
}

