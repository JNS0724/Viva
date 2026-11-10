import type { ProposalDraft, RepeatKind, ScheduleRuleView } from '../proposal-types.ts'
import { calendarDays, formatDate } from '../../shared/i18n/format.ts'
import { onLocaleChange, getLocale } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { formatHM } from '../selectors.ts'
import type { ProposalCard } from '../proposal-state.ts'
import { cronShape, draftOf, MAX_TITLE_CHARS } from '../proposal-draft.ts'
import { h } from './dom.ts'

/**
 * The card a schedule's proposal puts in the conversation (要我定时做吗？: when it runs and what it will do;
 * 定时 / 修改 / 不用), its form for changing it before saying yes, and how times read in the window (今天 17:00,
 * 明天 09:00, 周五 17:00).
 */
const BUTTON = Object.freeze({ primary: 'btn btn-primary', accent: 'btn btn-accent', secondary: 'btn btn-secondary', text: 'btn btn-text' })
let WEEKDAYS = [t("followups.sunday"), t("followups.monday"), t("followups.tuesday"), t("followups.wednesday"), t("followups.thursday"), t("followups.friday"), t("followups.saturday")]
const WEEK_DAYS = 7
/** Monday to Friday, ISO: said 工作日. */
const WORKDAYS = '1,2,3,4,5'
/** Days some months lack: the form says those months are skipped. */
const SHORT_MONTH_DAY = 29
const MAX_MONTH_DAY = 31
/** Monday first, as the week reads in a calendar. */
const ISO_WEEK = Object.freeze([1, 2, 3, 4, 5, 6, 7])

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

/** 每周一、三 09:00, or 工作日 09:00 for Monday to Friday. */
function weeklyText(weekdays: readonly number[], time: string): string {
  if (weekdays.join(',') === WORKDAYS) return t('schedule.workdays', { time })
  return t('schedule.weekly', { days: weekdays.map((day) => WEEKDAYS[day % WEEK_DAYS]).join('、'), time })
}

/**
 * How often a schedule runs, in words: once, every day, on its weekdays, on a day of the month. A cron reads in these
 * words when it says no more than they do; only one that does shows its expression.
 */
export function scheduleWhen(rule: ScheduleRuleView, firstAt: string, now: number): string {
  const first = whenText(Date.parse(firstAt), now)
  if (rule?.kind === 'daily') return t('schedule.daily', { time: String(rule.daily?.time ?? '').slice(0, 5) })
  if (rule?.kind === 'weekly') return weeklyText(rule.weekly?.weekdays ?? [], String(rule.weekly?.time ?? '').slice(0, 5))
  if (rule?.kind === 'cron') {
    const shape = cronShape(String(rule.cron?.expression ?? ''))
    if (shape?.repeat === 'daily') return t('schedule.daily', { time: shape.time })
    if (shape?.repeat === 'weekly') return weeklyText(shape.weekdays, shape.time)
    if (shape?.repeat === 'monthly') return t('schedule.monthly', { day: shape.day, time: shape.time })
    return t('schedule.cron', { expression: String(rule.cron?.expression ?? ''), first })
  }
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

const REPEAT_LABEL: Record<RepeatKind, () => string> = {
  at: () => t('schedule.repeat.at'), daily: () => t('schedule.repeat.daily'), weekly: () => t('schedule.repeat.weekly'),
  monthly: () => t('schedule.repeat.monthly'), cron: () => t('schedule.repeat.cron'),
}
/** The repeats the form offers; 自定义 only for a cron the others cannot say, which it keeps as written. */
const repeatsFor = (draft: ProposalDraft): RepeatKind[] => (draft.expression && draft.repeat === 'cron'
  ? ['at', 'daily', 'weekly', 'monthly', 'cron'] : ['at', 'daily', 'weekly', 'monthly'])

/** The form's fields, named by card so two open forms never share a value (dom.ts keepingInput). */
const fieldName = (id: string, field: string) => `proposal-${field}-${id}`

/** What the form says now: the draft it was built from, with what was typed and picked since. */
function readDraft(form: HTMLFormElement, id: string, base: ProposalDraft): ProposalDraft {
  const value = (field: string) => (form.elements.namedItem(fieldName(id, field)) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value ?? ''
  const checked = (day: number) => (form.elements.namedItem(fieldName(id, `day-${day}`)) as HTMLInputElement | null)?.checked ?? false
  return {
    ...base, title: value('title'), prompt: value('prompt'), repeat: value('repeat') as RepeatKind, date: value('date'), time: value('time'),
    weekdays: ISO_WEEK.filter(checked), day: Number(value('day')), expression: value('expression'),
  }
}

/**
 * One row of the form: its label, then its field. `shown` lists the repeats it belongs to; the stylesheet shows it
 * only while one of them is picked, so switching 重复 needs no redraw and loses nothing typed.
 */
const row = (label: string, field: HTMLElement, shown?: readonly RepeatKind[], top = false) => h('label', {
  class: top ? 'fu-edit-row top' : 'fu-edit-row', ...(shown ? { 'data-for': shown.join(' ') } : {}),
}, h('span', { class: 'label', text: label }), field)

/** The weekdays, Monday first, each a checkbox on a chip: several may be picked. */
function weekdayPicks(id: string, picked: readonly number[], disabled: boolean) {
  return h('div', { class: 'fu-edit-row', 'data-for': 'weekly', role: 'group', 'aria-label': t('schedule.edit.weekdays') },
    h('span', { class: 'label', text: t('schedule.edit.weekdays') }),
    h('div', { class: 'fu-days' }, ...ISO_WEEK.map((day) => h('label', { class: 'fu-day' },
      h('input', { class: 'sr-only', type: 'checkbox', name: fieldName(id, `day-${day}`), checked: picked.includes(day), disabled }),
      h('span', { text: WEEKDAYS[day % WEEK_DAYS] })))))
}

/** 修改: the proposal as a form (name, what it does, how often and when), kept on 定时 as it says. */
function editForm(card: ProposalCard, handlers: Handlers, now: number) {
  const base = card.draft ?? draftOf(card.proposal, now)
  const disabled = !!card.busy
  const input = (field: string, attrs: Record<string, unknown>) => h('input', { class: 'field', name: fieldName(card.id, field), disabled, ...attrs })
  const repeat = h('select', { class: 'field', name: fieldName(card.id, 'repeat'), disabled },
    ...repeatsFor(base).map((kind) => h('option', { value: kind, text: REPEAT_LABEL[kind](), selected: kind === base.repeat })))
  const form = h('form', {
    // Checked by the repeat picked (proposal-draft.ts editsOf): the browser's own checks would hold back 定时 for a
    // field hidden with another repeat.
    class: 'fu-form', 'aria-label': t('schedule.card.edit'), novalidate: true,
    onSubmit: (event: Event) => {
      event.preventDefault()
      handlers.acceptProposal(card.id, readDraft(form as HTMLFormElement, card.id, base))
    },
  },
  row(t('schedule.edit.title'), input('title', { value: base.title, maxlength: MAX_TITLE_CHARS, autocomplete: 'off' })),
  row(t('schedule.edit.prompt'), h('textarea', { class: 'field fu-prompt', name: fieldName(card.id, 'prompt'), rows: 3, disabled, text: base.prompt }), undefined, true),
  row(t('schedule.edit.repeat'), repeat),
  row(t('schedule.edit.date'), input('date', { type: 'date', value: base.date }), ['at']),
  weekdayPicks(card.id, base.weekdays, disabled),
  row(t('schedule.edit.day'), h('div', { class: 'fu-inline' },
    input('day', { type: 'number', min: 1, max: MAX_MONTH_DAY, step: 1, value: String(base.day), inputmode: 'numeric' }),
    base.day >= SHORT_MONTH_DAY ? h('span', { class: 'fu-note', text: t('schedule.edit.day.late') }) : null), ['monthly']),
  row(t('schedule.edit.time'), input('time', { type: 'time', value: base.time }), ['at', 'daily', 'weekly', 'monthly']),
  row(t('schedule.edit.expression'), input('expression', { class: 'field mono', value: base.expression, spellcheck: 'false', autocomplete: 'off' }), ['cron']),
  h('div', { class: 'confirm-actions' },
    h('button', { class: BUTTON.primary, type: 'submit', text: t('schedule.card.accept'), disabled }),
    h('button', { class: BUTTON.secondary, type: 'button', text: t('schedule.card.cancel'), disabled, onClick: () => handlers.editProposal(card.id, false) }),
    h('span', { class: 'confirm-hint', text: t('schedule.card.hint') })))
  return form
}

/** 要我定时做吗？ in the conversation: when it runs and what it will do; kept only on 定时, changed first on 修改. */
export function proposalCard(card: ProposalCard, handlers: Handlers, now = Date.now()) {
  if (card.status !== 'open') return decidedCard(card, now)
  const { proposal } = card
  const head = h('div', { class: 'confirm-head' }, h('span', { text: t('schedule.card.ask') }), h('span', { class: 'pulse-dot' }))
  const error = card.error ? h('p', { class: 'form-error', role: 'alert', text: card.error }) : null
  if (card.editing) return h('section', { class: 'confirm fu-card', 'aria-label': t('schedule.card.ask') }, head, editForm(card, handlers, now), error)
  const line = (when: string, what: string) => h('div', { class: 'fu-line' }, h('span', { class: 'fu-when mono', text: when }), h('span', { text: what }))
  return h('section', { class: 'confirm fu-card', 'aria-label': t('schedule.card.ask') }, head,
    h('div', { class: 'confirm-title', text: proposal.title }),
    h('div', { class: 'fu-lines' }, line(scheduleWhen(proposal.rule, proposal.firstAt, now), proposal.prompt)),
    h('div', { class: 'confirm-actions' },
      h('button', { class: BUTTON.primary, type: 'button', text: t('schedule.card.accept'), disabled: card.busy, onClick: () => handlers.acceptProposal(card.id) }),
      h('button', { class: BUTTON.secondary, type: 'button', text: t('schedule.card.edit'), disabled: card.busy, onClick: () => handlers.editProposal(card.id, true) }),
      h('button', { class: BUTTON.text, type: 'button', text: t('schedule.card.decline'), disabled: card.busy, onClick: () => handlers.declineProposal(card.id) }),
      h('span', { class: 'confirm-hint', text: t('schedule.card.hint') })),
    error)
}

onLocaleChange(() => {
  WEEKDAYS = [t("followups.sunday"), t("followups.monday"), t("followups.tuesday"), t("followups.wednesday"), t("followups.thursday"), t("followups.friday"), t("followups.saturday")]
})
