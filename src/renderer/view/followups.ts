import { calendarDays, formatDate } from '../../shared/i18n/format.ts'
import { onLocaleChange, getLocale } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { formatHM } from '../selectors.ts'
import type { ProposalCard } from '../followup-state.ts'
import { awaitsPreparation, feedActionsOf, showsDraft, type FeedAction } from '../feed-state.ts'
import { h } from './dom.ts'
import { maidFor } from './maid.ts'
import type { MaidSlots } from './maid.ts'
import { renderMarkdown } from './markdown.ts'

/** A follow-up's page heads with her, still: this page is for reading (docs/ui-guidelines.md, motion). */
const DETAIL_MAID_PX = 64
const detailMaids: MaidSlots = new Map()
const detailMood = (status: string) => (status === 'ready' ? 'done' : status === 'preparing' ? 'typing' : 'idle')

/**
 * Follow-ups in the window: the card a proposal puts under the conversation (要我跟进吗？: what will be prepared
 * when, when the user is reminded; 跟进 / 不用 / 以后别问这类), and on the 后台 page each follow-up with its draft.
 * The copy says what happens and what it gives back; the background preparation's codename stays out of it.
 */
const BUTTON = Object.freeze({ primary: 'btn btn-primary', accent: 'btn btn-accent', secondary: 'btn btn-secondary', text: 'btn btn-text' })
let WEEKDAYS = [t("followups.sunday"), t("followups.monday"), t("followups.tuesday"), t("followups.wednesday"), t("followups.thursday"), t("followups.friday"), t("followups.saturday")]
const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_DAYS = 7
export let PRESET_NAMES: Readonly<Record<string, string>> = { three: t("followups.three.times.a.day"), two: t("followups.twice.a.day"), one: t("followups.once.a.day"), custom: t("followups.custom") }
export const PRESET_TIMES: Readonly<Record<string, string>> = { three: '08:30 / 12:30 / 16:30', two: '09:00 / 17:00', one: '08:30' }

const startOfDay = (ts: number) => new Date(ts).setHours(0, 0, 0, 0)

/** 今天 17:00, 明天 09:00, 周五 17:00 within the week, 10月30日 17:00 further off. */
export function whenText(ts: number, now = Date.now()): string {
  const date = new Date(ts)
  const days = calendarDays(now, ts)
  const time = formatHM(date)
  if (days === 0) return t("followups.today", { time: time })
  if (days === 1) return t("followups.tomorrow", { time: time })
  if (days > 1 && days < WEEK_DAYS) return `${WEEKDAYS[date.getDay()]} ${time}`
  if (getLocale() === 'en') return `${formatDate(date, { month: 'short', day: 'numeric' })} ${time}`
  return t("followups.label", { value1: date.getMonth() + 1, value2: date.getDate(), time: time })
}

const parsed = (iso: string | null) => (iso ? Date.parse(iso) : NaN)

/** How often a schedule runs, in words: once, every day, every week on its days, or its cron expression. */
export function scheduleWhen(rule: Untyped, firstAt: string, now: number): string {
  const first = whenText(Date.parse(firstAt), now)
  if (rule?.kind === 'daily') return t('schedule.daily', { time: String(rule.daily?.time ?? '').slice(0, 5) })
  if (rule?.kind === 'weekly') {
    const days = (rule.weekly?.weekdays ?? []).map((day: number) => WEEKDAYS[day % 7]).join('、')
    return t('schedule.weekly', { days, time: String(rule.weekly?.time ?? '').slice(0, 5) })
  }
  if (rule?.kind === 'cron') return t('schedule.cron', { expression: String(rule.cron?.expression ?? ''), first })
  return first
}

/** Decided: kept, with when it runs first; or not. */
function decidedCard(card: ProposalCard, now: number) {
  const { proposal } = card
  if (card.status !== 'accepted') {
    return h('section', { class: 'confirm fu-card fu-done', 'aria-label': t('schedule.card.declined') },
      h('p', { class: 'fu-note', text: t('schedule.card.declined') }))
  }
  return h('section', { class: 'confirm fu-card fu-done', 'aria-label': t('schedule.card.accepted', { title: proposal.title }) },
    h('div', { class: 'fu-title' }, h('b', { text: t('schedule.card.accepted', { title: proposal.title }) })),
    h('p', { class: 'fu-note', text: t('schedule.card.next', { when: scheduleWhen(proposal.rule, card.accepted?.nextAt ?? proposal.firstAt, now) }) }))
}

/** 要我定时做吗？ under the conversation: when it runs and what it will do; kept only on 定时. */
export function proposalCard(card: ProposalCard, handlers: Handlers, now = Date.now()) {
  if (card.status !== 'open') return decidedCard(card, now)
  const { proposal } = card
  const line = (when: string, what: string) => h('div', { class: 'fu-line' }, h('span', { class: 'fu-when mono', text: when }), h('span', { text: what }))
  return h('section', { class: 'confirm fu-card', 'aria-label': t('schedule.card.ask') },
    h('div', { class: 'confirm-head' }, h('span', { text: t('schedule.card.ask') }), h('span', { class: 'pulse-dot' })),
    h('div', { class: 'confirm-title', text: proposal.title }),
    h('div', { class: 'fu-lines' }, line(scheduleWhen(proposal.rule, proposal.firstAt, now), proposal.prompt)),
    h('div', { class: 'confirm-actions' },
      h('button', { class: BUTTON.primary, type: 'button', text: t('schedule.card.accept'), disabled: card.busy, onClick: () => handlers.acceptProposal(card.id) }),
      h('button', { class: BUTTON.secondary, type: 'button', text: t('schedule.card.decline'), disabled: card.busy, onClick: () => handlers.declineProposal(card.id) }),
      h('span', { class: 'confirm-hint', text: t('schedule.card.hint') })),
    card.error ? h('p', { class: 'form-error', role: 'alert', text: card.error }) : null)
}

/** What a follow-up waits on, in a few words, for the 后台 page's list. */
export function followupStanding(followup: Untyped, now = Date.now()): string {
  if (followup.status === 'ready') return followup.draftAt ? t("followups.ready.at", { value1: formatHM(new Date(followup.draftAt)) }) : t("followups.ready")
  if (followup.status === 'preparing') return t("followups.preparing")
  if (followup.prepareBy) return t("followups.prepare.before", { value1: whenText(followup.prepareBy, now) })
  if (followup.remindAt) return t("followups.remind.at", { value1: whenText(followup.remindAt, now) })
  return ''
}

/** Where the follow-up came from, for its detail. */
let ORIGIN_NAMES: Readonly<Record<string, string>> = { chat: t("followups.from.conversation"), file: t("followups.files.you.named"), manual: t("followups.added.by.you") }
let PREPARE_PROMISE = t("followups.prepare.read.only.in.the.background.read")

function detailActions(followup: Untyped, handlers: Handlers) {
  const button = (kind: keyof typeof BUTTON, text: string, onClick: () => unknown) => h('button', { class: BUTTON[kind], type: 'button', text, onClick })
  const BUTTONS: Readonly<Record<FeedAction, () => HTMLElement>> = {
    continue: () => button('accent', t('feed.continue'), () => handlers.continueFollowup(followup.id)),
    dismiss: () => button('text', t('feed.no'), () => handlers.dismissFollowup(followup.id)),
    wake: () => button('secondary', t("followups.wake.up"), () => handlers.wakePreparation()),
    'prepare-now': () => button('secondary', t("followups.prepare.now"), () => handlers.prepareFollowupNow(followup.id)),
    delete: () => button('text', t("followups.delete"), () => handlers.dismissFollowup(followup.id)),
  }
  return feedActionsOf(followup).map((action) => BUTTONS[action]())
}

/** A follow-up picked on the 动态 page (view/feed-page.ts): what it is, when, its draft, and what can be done with it. */
export function followupDetail(followup: Untyped, prepare: Untyped, handlers: Handlers, now = Date.now()) {
  const facts = [
    ORIGIN_NAMES[followup.origin] ?? '',
    followup.prepareBy ? t("followups.ready.before", { value1: whenText(followup.prepareBy, now) }) : null,
    followup.remindAt ? t("followups.remind.at", { value1: whenText(followup.remindAt, now) }) : null,
    followup.files?.length ? t("followups.will.read.2", { value1: followup.files.join('、') }) : null,
  ].filter(Boolean).join(' · ')
  const waiting = followup.status === 'preparing' ? t("followups.preparing.in.the.background", { value1: prepare?.queued ? t("followups.more.queued", { queued: prepare.queued }) : '' }) : prepare?.waiting ? t("handoff.prepare.waiting", { reason: prepare.waiting }) : PREPARE_PROMISE
  return h('div', { class: 'tp-main fu-main', 'data-followup': followup.id },
    h('header', { class: 'tp-head' },
      maidFor(detailMaids, 'detail', detailMood(followup.status), { size: DETAIL_MAID_PX }),
      h('h2', { class: 'tp-title', text: followup.title }),
      h('span', { class: 'tp-status', text: followupStanding(followup, now) })),
    h('div', { class: 'tp-scroll fu-scroll' },
      h('p', { class: 'fu-ask', text: followup.ask }),
      h('p', { class: 'fu-note', text: facts }),
      followup.lateFrom ? h('span', { class: 'fu-late', text: t("followups.the.computer.was.asleep.originally.scheduled.for", { value1: whenText(followup.lateFrom, now) }) }) : null,
      showsDraft(followup)
        ? h('article', { class: 'fu-draft' }, renderMarkdown(followup.draft, { openLink: handlers.openLink }))
        : awaitsPreparation(followup) ? h('p', { class: 'fu-note', text: waiting }) : null,
      h('div', { class: 'confirm-actions fu-actions' }, detailActions(followup, handlers),
        awaitsPreparation(followup) && prepare?.waiting ? h('span', { class: 'fu-note', role: 'status', text: t("handoff.prepare.reason", { reason: prepare.waiting }) }) : null),
      showsDraft(followup) ? h('p', { class: 'fu-note', text: t("handoff.prepare.continue.scope") }) : null))
}

onLocaleChange(() => {
  WEEKDAYS = [t("followups.sunday"), t("followups.monday"), t("followups.tuesday"), t("followups.wednesday"), t("followups.thursday"), t("followups.friday"), t("followups.saturday")]
  PRESET_NAMES = { three: t("followups.three.times.a.day"), two: t("followups.twice.a.day"), one: t("followups.once.a.day"), custom: t("followups.custom") }
  ORIGIN_NAMES = { chat: t("followups.from.conversation"), file: t("followups.files.you.named"), manual: t("followups.added.by.you") }
  PREPARE_PROMISE = t("followups.prepare.read.only.in.the.background.read")
})
