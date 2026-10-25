import { h, label } from './dom.ts'
import { PRESET_NAMES, PRESET_TIMES, whenText } from './followups.ts'

/**
 * 后台准备 in settings: when background preparation may run (a preset, or times of the user's own; weekends apart),
 * what it costs and what it misses (the calls today, how often a reminder came before the draft this week), and a
 * pause. The form is read as it is when saved; the main process checks it (prepare-schedule.ts).
 */
const WEEKEND_NAMES: Readonly<Record<string, string>> = { same: '和工作日一样', off: '周末不准备', custom: '周末另设时段' }
const TRADE_OFF = '你没在用 Viva 的时候，在这些时段把要跟进的事一起准备好：只读、只起草。时段越少越省，但提醒前来不及准备的就越多。'
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
    prepare?.running ? `正在准备「${prepare.current}」` : followups.nextWindow ? `下次 ${whenText(followups.nextWindow, now)}` : '最近没有时段',
    `今天调用 ${followups.callsToday}/${plan.dailyCalls}`,
    `最近一周来不及准备 ${followups.lateThisWeek} 次`,
  ]
  return h('span', { class: 'help', text: parts.join(' · ') })
}

/** 最近一周: the figures the week of self-use is judged by (followup-stats.ts), when there are any. */
function weekBlock(week: Untyped) {
  if (!week || (!week.suggestions.shown && !week.calls.total && !week.notices.sent)) return null
  const percent = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`)
  const lines = [
    `建议 ${week.suggestions.shown} 条：跟进 ${week.suggestions.accepted}，不用 ${week.suggestions.declined}，别问 ${week.suggestions.never}（接受率 ${percent(week.suggestions.acceptRate)}）`,
    `通知 ${week.notices.sent} 条，点开 ${week.notices.opened} 条${week.notices.medianOpenMinutes === null ? '' : `，一般 ${week.notices.medianOpenMinutes} 分钟后点开`}`,
    `调用模型 ${week.calls.total} 次（每天 ${week.calls.perDay.join(' / ')}）${week.calls.perAccepted === null ? '' : `，每条跟进的建议约 ${week.calls.perAccepted} 次`}`,
    `准备好的：接着做 ${week.continued}，不用了 ${week.dismissed}；来不及准备 ${week.late} 次`,
  ]
  return h('details', { class: 'prepare-week' },
    h('summary', { class: 'help', text: '最近一周的情况' }),
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
    class: 'prepare-form', 'aria-label': '后台准备的时段',
    onSubmit: (event: SubmitEvent) => {
      event.preventDefault()
      handlers.savePrepareSchedule(formValues(event.currentTarget as HTMLFormElement))
    },
  },
  row('时段', select('prepare-preset', plan.preset, PRESET_NAMES, version, '时段'), h('span', { class: 'help mono', text: PRESET_TIMES[plan.preset] ?? '' })),
  row('自定义时段', input('prepare-weekday', plan.weekday.join(', '), '08:30, 12:30', '自定义时段'), h('span', { class: 'help', text: '选「自定义」时用；最多 6 个，相邻至少隔 1 小时' })),
  row('周末', select('prepare-weekend-mode', plan.weekendMode, WEEKEND_NAMES, version, '周末'), input('prepare-weekend', plan.weekend.join(', '), '10:00', '周末的时段')),
  h('div', { class: 'settings-actions' },
    h('button', { class: 'btn btn-accent btn-small', type: 'submit', disabled: followups.busy, text: followups.busy ? '保存中…' : '保存' }),
    h('button', {
      class: 'btn btn-outline btn-small', type: 'button', disabled: followups.busy, text: paused ? '继续后台准备' : '暂停 1 小时',
      onClick: () => handlers.pausePreparation(paused ? 0 : PAUSE_MINUTES),
    })))
  return h('section', { class: 'ext', 'aria-label': '后台准备' },
    h('span', { class: 'pref-copy' },
      h('span', { class: 'profile-heading', text: '后台准备' }),
      h('span', { class: 'help', text: TRADE_OFF }),
      paused ? h('span', { class: 'help', text: `暂停到 ${whenText(plan.pausedUntil, now)}` }) : statusLine(followups, now)),
    form,
    weekBlock(followups.week),
    followups.error ? h('p', { class: 'form-error', role: 'alert', text: followups.error }) : null,
    followups.notice ? h('p', { class: 'form-notice', role: 'status', text: followups.notice }) : null)
}
