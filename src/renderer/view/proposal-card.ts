import type { ScheduleRuleView } from '../proposal-types.ts'
import { calendarDays, formatDate } from '../../shared/i18n/format.ts'
import { onLocaleChange, getLocale } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { formatHM } from '../selectors.ts'
import type { ProposalCard } from '../proposal-state.ts'
import { h } from './dom.ts'

/**
 * The card a schedule's proposal puts under the conversation (要我定时做吗？: when it runs and what it will do;
 * 定时 / 不用), and how times read in the window (今天 17:00, 明天 09:00, 周五 17:00).
 */
const BUTTON = Object.freeze({ primary: 'btn btn-primary', accent: 'btn btn-accent', secondary: 'btn btn-secondary', text: 'btn btn-text' })
let WEEKDAYS = [t("followups.sunday"), t("followups.monday"), t("followups.tuesday"), t("followups.wednesday"), t("followups.thursday"), t("followups.friday"), t("followups.saturday")]
const WEEK_DAYS = 7

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

/** How often a schedule runs, in words: once, every day, every week on its days, or its cron expression. */
export function scheduleWhen(rule: ScheduleRuleView, firstAt: string, now: number): string {
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

onLocaleChange(() => {
  WEEKDAYS = [t("followups.sunday"), t("followups.monday"), t("followups.tuesday"), t("followups.wednesday"), t("followups.thursday"), t("followups.friday"), t("followups.saturday")]
})
