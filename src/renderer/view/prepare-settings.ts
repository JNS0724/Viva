import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { h, label } from './dom.ts'
import { PRESET_NAMES, PRESET_TIMES, whenText } from './followups.ts'

/**
 * 后台准备 in settings: when background preparation may run (a preset, or times of the user's own; weekends apart),
 * what it costs and what it misses (the calls today, how often a reminder came before the draft this week), and a
 * pause. The form is read as it is when saved; the main process checks it (prepare-schedule.ts).
 */
let WEEKEND_NAMES: Readonly<Record<string, string>> = { same: t("prepare-settings.same.as.weekdays"), off: t("prepare-settings.no.weekend.preparation"), custom: t("prepare-settings.separate.weekend.windows") }
let TRADE_OFF = t("prepare-settings.while.you.are.not.using.viva.prepare")
const PAUSE_MINUTES = 60

const times = (value: FormDataEntryValue | null) => String(value ?? '').split(/[,，、\s]+/).map((time) => time.trim()).filter(Boolean)

function formValues(form: HTMLFormElement) {
  const data = new FormData(form)
  return {
    preset: String(data.get('prepare-preset') ?? 'three'),
    weekday: times(data.get('prepare-weekday')),
    weekendMode: String(data.get('prepare-weekend-mode') ?? 'same'),
    weekend: times(data.get('prepare-weekend')),
  }
}

function select(name: string, value: string, options: Readonly<Record<string, string>>, version: string, aria: string) {
  return h('select', { class: 'field', name, 'data-version': version, 'aria-label': aria },
    Object.entries(options).map(([key, text]) => h('option', { value: key, selected: key === value, text })))
}

function statusLine(followups: State['followups'], now: number) {
  const plan = followups.schedule
  const prepare = followups.state
  const parts = [
    prepare?.running ? t("prepare-settings.preparing", { current: prepare.current }) : followups.nextWindow ? t("prepare-settings.next", { value1: whenText(followups.nextWindow, now) }) : t("prepare-settings.no.upcoming.windows"),
    t("prepare-settings.calls.today", { callsToday: followups.callsToday, dailyCalls: plan.dailyCalls }),
    t("prepare-settings.missed.preparation.deadlines.this.week", { lateThisWeek: followups.lateThisWeek }),
  ]
  return h('span', { class: 'help', text: parts.join(' · ') })
}

/** 最近一周: the figures the week of self-use is judged by (followup-stats.ts), when there are any. */
function weekBlock(week: Untyped) {
  if (!week || (!week.suggestions.shown && !week.calls.total && !week.notices.sent)) return null
  const percent = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`)
  const lines = [
    t("prepare-settings.suggestions.accepted.dismissed.muted.acceptance.rate", { shown: week.suggestions.shown, accepted: week.suggestions.accepted, declined: week.suggestions.declined, never: week.suggestions.never, value5: percent(week.suggestions.acceptRate) }),
    t("prepare-settings.notifications.opened", { sent: week.notices.sent, opened: week.notices.opened, value3: week.notices.medianOpenMinutes === null ? '' : t("prepare-settings.typically.opened.after.minutes", { medianOpenMinutes: week.notices.medianOpenMinutes }) }),
    t("prepare-settings.model.calls.per.day", { total: week.calls.total, value2: week.calls.perDay.join(' / '), value3: week.calls.perAccepted === null ? '' : t("prepare-settings.about.per.accepted.suggestion", { perAccepted: week.calls.perAccepted }) }),
    t("prepare-settings.prepared.drafts.continued.dismissed.missed.deadlines", { continued: week.continued, dismissed: week.dismissed, late: week.late }),
  ]
  return h('details', { class: 'prepare-week' },
    h('summary', { class: 'help', text: t("prepare-settings.this.past.week") }),
    h('ul', { class: 'help' }, lines.map((line) => h('li', { text: line }))))
}

const row = (title: string, ...fields: unknown[]) => h('div', { class: 'ext-edit-row' }, label(title), h('div', { class: 'source-field' }, ...fields))

/** The 后台准备 part of settings. */
export function prepareSection(followups: State['followups'], handlers: Handlers, now = Date.now()) {
  const plan = followups.schedule
  if (!followups.loaded || !plan) return null
  const version = JSON.stringify([plan.preset, plan.weekday, plan.weekendMode, plan.weekend])
  const paused = Boolean(plan.pausedUntil && plan.pausedUntil > now)
  const input = (name: string, value: string, placeholder: string, aria: string) =>
    h('input', { class: 'field mono', name, 'data-version': version, value, placeholder, 'aria-label': aria, autocomplete: 'off', spellcheck: 'false' })
  const form = h('form', {
    class: 'prepare-form', 'aria-label': t("followups.background.preparation.schedule"),
    onSubmit: (event: SubmitEvent) => {
      event.preventDefault()
      handlers.savePrepareSchedule(formValues(event.currentTarget as HTMLFormElement))
    },
  },
  row(t("prepare-settings.schedule"), select('prepare-preset', plan.preset, PRESET_NAMES, version, t("prepare-settings.schedule")), h('span', { class: 'help mono', text: PRESET_TIMES[plan.preset] ?? '' })),
  row(t("prepare-settings.custom.windows"), input('prepare-weekday', plan.weekday.join(', '), '08:30, 12:30', t("prepare-settings.custom.windows")), h('span', { class: 'help', text: t("prepare-settings.for.custom.up.to.windows.at.least") })),
  row(t("prepare-settings.weekends"), select('prepare-weekend-mode', plan.weekendMode, WEEKEND_NAMES, version, t("prepare-settings.weekends")), input('prepare-weekend', plan.weekend.join(', '), '10:00', t("prepare-settings.weekend.windows"))),
  h('div', { class: 'settings-actions' },
    h('button', { class: 'btn btn-accent btn-small', type: 'submit', disabled: followups.busy, text: followups.busy ? t("extensions.saving") : t("extensions.save") }),
    h('button', {
      class: 'btn btn-outline btn-small', type: 'button', disabled: followups.busy, text: paused ? t("prepare-settings.resume.preparation") : t("prepare-settings.pause.for.hour"),
      onClick: () => handlers.pausePreparation(paused ? 0 : PAUSE_MINUTES),
    })))
  return h('section', { class: 'ext', 'aria-label': t("prepare-settings.background.preparation") },
    h('span', { class: 'pref-copy' },
      h('span', { class: 'profile-heading', text: t("prepare-settings.background.preparation") }),
      h('span', { class: 'help', text: TRADE_OFF }),
      paused ? h('span', { class: 'help', text: t("prepare-settings.paused.until", { value1: whenText(plan.pausedUntil, now) }) }) : statusLine(followups, now)),
    form,
    weekBlock(followups.week),
    followups.error ? h('p', { class: 'form-error', role: 'alert', text: followups.error }) : null,
    followups.notice ? h('p', { class: 'form-notice', role: 'status', text: followups.notice }) : null)
}

onLocaleChange(() => {
  WEEKEND_NAMES = { same: t("prepare-settings.same.as.weekdays"), off: t("prepare-settings.no.weekend.preparation"), custom: t("prepare-settings.separate.weekend.windows") }
  TRADE_OFF = t("prepare-settings.while.you.are.not.using.viva.prepare")
})
