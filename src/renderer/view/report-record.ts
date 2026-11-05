import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { reportRecordOf } from '../../shared/task-report.ts'
import { h } from './dom.ts'
import { statusMark } from './task-card.ts'

/**
 * A background task's result the model was given (system-design §12.4 point 7), as one quiet line where it came:
 * which task, how it went (into the turn that was running, or a turn of its own), and when; opened, the note as the
 * model was given it and a way to the task's page. The backend keeps it (report-records.ts); it is drawn after the
 * message it came after (view/thread.ts, view/earlier.ts).
 */

/** Records the user opened, this session: a redraw leaves them open. */
const opened = new Set<string>()
let EXPAND = t('thread.report.expand')
let COLLAPSE = t('thread.report.collapse')

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (at: number) => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }

function setOpen(record: HTMLElement, body: HTMLElement, toggle: HTMLButtonElement, open: boolean) {
  record.dataset.open = String(open)
  body.hidden = !open
  toggle.setAttribute('aria-expanded', String(open))
  toggle.textContent = open ? COLLAPSE : EXPAND
}

export function reportRecord(kept: ReportRecord, handlers: Handlers): HTMLElement {
  const record = reportRecordOf(kept.text)
  const first = record?.tasks[0] ?? null
  const key = kept.reportId
  const more = record && record.tasks.length > 1 ? t('thread.report.more', { count: record.tasks.length - 1 }) : ''
  const body = h('div', { class: 'delivered-body' },
    h('span', { class: 'label', text: t('thread.report.original') }),
    h('pre', { class: 'delivered-text', text: kept.text }),
    first ? h('div', { class: 'delivered-actions' },
      h('button', { class: 'fold-act', type: 'button', text: t('thread.report.open.task'), onClick: () => handlers.openTasks(first.taskId) })) : null)
  const toggle = h('button', { class: 'fold-act delivered-toggle', type: 'button' }) as HTMLButtonElement
  const view = h('section', { class: 'msg-delivered', 'aria-label': t('thread.report.label') },
    h('div', { class: 'delivered-row' },
      statusMark('done'),
      first ? h('span', { class: 'task-name', text: `#${first.title}` }) : null,
      more ? h('span', { class: 'delivered-more', text: more }) : null,
      h('span', { class: 'delivered-said', text: t(record?.inTurn ? 'thread.report.in.turn' : 'thread.report.own.turn') }),
      h('span', { class: 'delivered-when', text: clock(kept.at) }),
      toggle),
    body)
  toggle.addEventListener('click', () => {
    const open = view.dataset.open !== 'true'
    if (open) opened.add(key)
    else opened.delete(key)
    setOpen(view, body, toggle, open)
  })
  setOpen(view, body, toggle, opened.has(key))
  return view
}

onLocaleChange(() => {
  EXPAND = t('thread.report.expand')
  COLLAPSE = t('thread.report.collapse')
  for (const toggle of document.querySelectorAll<HTMLButtonElement>('.delivered-toggle')) {
    toggle.textContent = toggle.getAttribute('aria-expanded') === 'true' ? COLLAPSE : EXPAND
  }
})
