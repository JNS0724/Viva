import { calendarDays, formatDate } from '../../shared/i18n/format.ts'
import { onLocaleChange, getLocale } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { formatHM } from '../selectors.ts'
import type { ProposalCard } from '../followup-state.ts'
import { h } from './dom.ts'
import { renderMarkdown } from './markdown.ts'

/**
 * Follow-ups in the window: the card a proposal puts under the conversation (要我跟进吗？: what will be prepared
 * when, when the user is reminded; 跟进 / 不用 / 以后别问这类), and on the 后台 page each follow-up with its draft.
 * The copy says what happens and what it gives back; the background preparation's codename stays out of it.
 */
const BUTTON = Object.freeze({ primary: 'btn btn-primary', secondary: 'btn btn-secondary', text: 'btn btn-text' })
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

/** The card's lines: when it is prepared (read-only, nothing sent), when the user is reminded, which files. */
function proposalLines(proposal: Untyped, now: number) {
  const prepareBy = parsed(proposal.prepareBy)
  const remindAt = parsed(proposal.remindAt)
  const line = (when: string, what: string) => h('div', { class: 'fu-line' }, h('span', { class: 'fu-when mono', text: when }), h('span', { text: what }))
  return [
    Number.isFinite(prepareBy) ? line(t("followups.before", { value1: whenText(prepareBy, now) }), t("followups.prepare.a.draft.in.the.background.read")) : null,
    Number.isFinite(remindAt) ? line(whenText(remindAt, now), t("followups.remind.you.to.review")) : null,
    proposal.files?.length ? line(t("followups.will.read"), proposal.files.join('、')) : null,
    proposal.watchFile ? line(t("followups.watch"), t("followups.when.changes.after.quiet.minutes.prepare.in", { watchFile: proposal.watchFile })) : null,
  ]
}

/** After 跟进, for the first follow-up that needs preparing: when preparation may run, one tap. */
function windowsChooser(card: ProposalCard, handlers: Handlers) {
  if (card.chosen) return h('p', { class: 'fu-note', text: t("followups.background.preparation.change.anytime.in.settings", { value1: PRESET_NAMES[card.chosen] }) })
  return h('div', { class: 'fu-choose', role: 'group', 'aria-label': t("followups.background.preparation.schedule") },
    h('span', { class: 'fu-note', text: t("followups.when.should.preparation.run.related.work.is") }),
    h('div', { class: 'fu-presets' }, ['three', 'two', 'one'].map((preset) => h('button', {
      class: `${preset === 'three' ? BUTTON.primary : BUTTON.secondary} fu-preset`, type: 'button', disabled: card.busy,
      onClick: () => handlers.chooseWindows(card.id, preset),
    }, h('b', { text: PRESET_NAMES[preset] }), h('span', { class: 'mono', text: PRESET_TIMES[preset] })))),
    h('span', { class: 'fu-note', text: t("followups.you.can.also.customize.weekday.and.weekend") }))
}

function decidedCard(card: ProposalCard, handlers: Handlers, now: number) {
  const { proposal } = card
  if (card.status !== 'accepted') {
    return h('section', { class: 'confirm fu-card fu-done', 'aria-label': t("followups.do.not.follow.up") },
      h('p', { class: 'fu-note', text: card.status === 'never' ? t("followups.okay.you.will.not.be.asked.about", { title: proposal.title }) : t("followups.okay.no.follow.up.you.will.not") }))
  }
  const accepted = card.accepted ?? {}
  const when = [
    accepted.prepareBy ? t("followups.prepare.in.the.background.before", { value1: whenText(accepted.prepareBy, now) }) : null,
    accepted.remindAt ? t("followups.remind.you.at", { value1: whenText(accepted.remindAt, now) }) : null,
  ].filter(Boolean).join('，')
  return h('section', { class: 'confirm fu-card fu-done', 'aria-label': t("followups.added.to.follow.ups") },
    h('div', { class: 'fu-title' }, h('b', { text: t("followups.added.to.follow.ups.2", { title: proposal.title }) })),
    h('p', { class: 'fu-note', text: t("followups.view.or.remove.in.background", { when: when }) }),
    card.chooseWindows ? windowsChooser(card, handlers) : null,
    card.error ? h('p', { class: 'form-error', role: 'alert', text: card.error }) : null)
}

/** 要我跟进吗？ under the conversation; decided, it says what was set or that it will not ask again. */
export function proposalCard(card: ProposalCard, handlers: Handlers, now = Date.now()) {
  if (card.status !== 'open') return decidedCard(card, handlers, now)
  const { proposal } = card
  return h('section', { class: 'confirm fu-card', 'aria-label': t("followups.would.you.like.me.to.follow.up") },
    h('div', { class: 'confirm-head' }, h('span', { text: t("followups.would.you.like.me.to.follow.up") }), h('span', { class: 'pulse-dot' })),
    h('div', { class: 'confirm-title', text: proposal.title }),
    h('p', { class: 'fu-ask', text: proposal.ask }),
    h('div', { class: 'fu-lines' }, proposalLines(proposal, now)),
    h('div', { class: 'confirm-actions' },
      h('button', { class: BUTTON.primary, type: 'button', text: t("followups.follow.up"), disabled: card.busy, onClick: () => handlers.acceptProposal(card.id) }),
      h('button', { class: BUTTON.secondary, type: 'button', text: t("followups.no.thanks"), disabled: card.busy, onClick: () => handlers.declineProposal(card.id) }),
      h('button', { class: BUTTON.text, type: 'button', text: t("followups.do.not.ask.about.this.kind.again"), disabled: card.busy, onClick: () => handlers.neverProposal(card.id) }),
      h('span', { class: 'confirm-hint', text: t("followups.only.takes.effect.after.you.click.follow") })),
    card.error ? h('p', { class: 'form-error', role: 'alert', text: card.error }) : null)
}

/** What a follow-up waits on, in a few words, for the 后台 page's list. */
export function followupStanding(followup: Untyped, now = Date.now()): string {
  if (followup.status === 'ready') return followup.draftAt ? t("followups.ready.at", { value1: formatHM(new Date(followup.draftAt)) }) : t("followups.ready")
  if (followup.status === 'preparing') return t("followups.preparing")
  if (followup.watching && !followup.prepareBy) return t("followups.watching", { watching: followup.watching })
  if (followup.prepareBy) return t("followups.prepare.before", { value1: whenText(followup.prepareBy, now) })
  if (followup.remindAt) return t("followups.remind.at", { value1: whenText(followup.remindAt, now) })
  return ''
}

/** A message suggested for a follow-up, picked on the 后台 page: the message, why, and 跟进 / 不重要 / 别问. */
export function suggestionDetail(suggestion: Untyped, handlers: Handlers, now = Date.now()) {
  const message = suggestion.message
  const open = suggestion.status === 'open'
  const button = (kind: keyof typeof BUTTON, text: string, action: string) =>
    h('button', { class: BUTTON[kind], type: 'button', text, onClick: () => handlers.settleSuggestion(suggestion.id, action) })
  return h('div', { class: 'tp-main fu-main', 'data-suggestion': suggestion.id },
    h('header', { class: 'tp-head' },
      h('h2', { class: 'tp-title', text: t("followups.this.looks.like.something.for.you.to") })),
    h('div', { class: 'tp-scroll fu-scroll' },
      message
        ? h('article', { class: 'fu-draft fu-message' },
          h('div', { class: 'fu-note', text: t("followups.label.2", { value1: message.from || suggestion.sender || t("followups.unknown"), value2: whenText(message.at, now) }) }),
          message.title ? h('b', { text: message.title }) : null,
          message.text ? h('p', { class: 'fu-ask', text: message.text }) : null)
        : h('p', { class: 'fu-note', text: t("followups.the.original.message.is.no.longer.available") }),
      h('p', { class: 'fu-note', text: t("followups.reason", { why: suggestion.why }) }),
      h('div', { class: 'fu-lines' },
        h('div', { class: 'fu-line' }, h('span', { class: 'fu-when mono', text: t("followups.after.following.up") }), h('span', { text: suggestion.ask })),
        suggestion.remindAt ? h('div', { class: 'fu-line' }, h('span', { class: 'fu-when mono', text: whenText(suggestion.remindAt, now) }), h('span', { text: t("followups.remind.you.and.prepare.a.draft.beforehand") })) : null),
      open
        ? h('div', { class: 'confirm-actions fu-actions' }, button('primary', t("followups.follow.up"), 'accept'), button('secondary', t("followups.not.important"), 'decline'), button('text', t("followups.do.not.ask.about.this.kind.again"), 'never'))
        : h('p', { class: 'fu-note', text: suggestion.status === 'accepted' ? t("followups.added.to.follow.ups") : t("followups.do.not.follow.up") }),
      h('p', { class: 'fu-note', text: t("followups.not.important.is.remembered.after.two.dismissals") })))
}

/** Where the follow-up came from, for its detail. */
let ORIGIN_NAMES: Readonly<Record<string, string>> = { chat: t("followups.from.conversation"), message: t("followups.from.messages"), file: t("followups.files.you.named"), manual: t("followups.added.by.you") }
let PREPARE_PROMISE = t("followups.prepare.read.only.in.the.background.read")

function detailActions(followup: Untyped, handlers: Handlers) {
  const button = (kind: keyof typeof BUTTON, text: string, onClick: () => unknown) => h('button', { class: BUTTON[kind], type: 'button', text, onClick })
  if (followup.status === 'ready') {
    return [
      button('primary', t("followups.continue"), () => handlers.continueFollowup(followup.id)),
      button('secondary', t("followups.run.in.background"), () => handlers.followupInBackground(followup.id)),
      button('text', t("followups.dismiss"), () => handlers.dismissFollowup(followup.id)),
    ]
  }
  return [
    followup.status === 'preparing'
      ? button('secondary', t("followups.wake.up"), () => handlers.wakePreparation())
      : button('secondary', t("followups.prepare.now"), () => handlers.prepareFollowupNow(followup.id)),
    button('text', t("followups.delete"), () => handlers.dismissFollowup(followup.id)),
  ]
}

/** A follow-up picked on the 后台 page: what it is, when, its draft, and what can be done with it. */
export function followupDetail(followup: Untyped, prepare: Untyped, handlers: Handlers, now = Date.now()) {
  const ready = followup.status === 'ready'
  const facts = [
    ORIGIN_NAMES[followup.origin] ?? '',
    followup.prepareBy ? t("followups.ready.before", { value1: whenText(followup.prepareBy, now) }) : null,
    followup.remindAt ? t("followups.remind.at", { value1: whenText(followup.remindAt, now) }) : null,
    followup.files?.length ? t("followups.will.read.2", { value1: followup.files.join('、') }) : null,
    followup.watching ? t("followups.watching.prepare.when.it.changes", { watching: followup.watching }) : null,
  ].filter(Boolean).join(' · ')
  const waiting = followup.status === 'preparing' ? t("followups.preparing.in.the.background", { value1: prepare?.queued ? t("followups.more.queued", { queued: prepare.queued }) : '' }) : prepare?.waiting ? t("handoff.prepare.waiting", { reason: prepare.waiting }) : PREPARE_PROMISE
  return h('div', { class: 'tp-main fu-main', 'data-followup': followup.id },
    h('header', { class: 'tp-head' },
      h('h2', { class: 'tp-title', text: followup.title }),
      h('span', { class: 'tp-status', text: followupStanding(followup, now) })),
    h('div', { class: 'tp-scroll fu-scroll' },
      h('p', { class: 'fu-ask', text: followup.ask }),
      h('p', { class: 'fu-note', text: facts }),
      followup.lateFrom ? h('span', { class: 'fu-late', text: t("followups.the.computer.was.asleep.originally.scheduled.for", { value1: whenText(followup.lateFrom, now) }) }) : null,
      ready && followup.draft
        ? h('article', { class: 'fu-draft' }, renderMarkdown(followup.draft, { openLink: handlers.openLink }))
        : h('p', { class: 'fu-note', text: waiting }),
      h('div', { class: 'confirm-actions fu-actions' }, detailActions(followup, handlers),
        !ready && prepare?.waiting ? h('span', { class: 'fu-note', role: 'status', text: t("handoff.prepare.reason", { reason: prepare.waiting }) }) : null),
      ready ? h('p', { class: 'fu-note', text: t("handoff.prepare.continue.scope") }) : null))
}

onLocaleChange(() => {
  WEEKDAYS = [t("followups.sunday"), t("followups.monday"), t("followups.tuesday"), t("followups.wednesday"), t("followups.thursday"), t("followups.friday"), t("followups.saturday")]
  PRESET_NAMES = { three: t("followups.three.times.a.day"), two: t("followups.twice.a.day"), one: t("followups.once.a.day"), custom: t("followups.custom") }
  ORIGIN_NAMES = { chat: t("followups.from.conversation"), message: t("followups.from.messages"), file: t("followups.files.you.named"), manual: t("followups.added.by.you") }
  PREPARE_PROMISE = t("followups.prepare.read.only.in.the.background.read")
})
