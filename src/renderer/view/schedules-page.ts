import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import type { ScheduleView } from '../../shared/ipc-results.ts'
import { scheduleGroups, selectedSchedule, shownScheduleId } from '../schedules-state.ts'
import { h } from './dom.ts'
import { maidFor, type MaidSlots } from './maid.ts'
import { whenText } from './proposal-card.ts'
import { queueLayout, reconcileChildren } from './reconcile.ts'

/**
 * 定时任务 (schedules-state.ts): a sub-page of the hub beside 后台, 关于你, 能力 and 设置.
 * Lists active and paused schedules on the left, and shows the selected schedule's timing, prompt and actions on the right.
 */
const MAID_PX = 64
const scheduleMaids: MaidSlots = new Map()

let KIND_NAMES: Readonly<Record<string, string>> = kindNames()
function kindNames() {
  return {
    at: t('schedules-page.at'),
    daily: t('schedules-page.daily'),
    weekly: t('schedules-page.weekly'),
    cron: t('schedules-page.cron'),
  }
}
onLocaleChange(() => { KIND_NAMES = kindNames() })

const scheduleStanding = (schedule: ScheduleView, now: number) => (schedule.status === 'paused'
  ? t('schedules-page.paused')
  : t('schedules-page.next.at', { when: whenText(Date.parse(schedule.nextAt), now) }))

interface RowEntry { el: HTMLButtonElement, name: HTMLSpanElement, meta: HTMLSpanElement }
interface GroupEntry { el: HTMLDivElement, label: Text, count: HTMLSpanElement }

function createSchedulesView(handlers: Handlers) {
  const titleEl = h('h1', { class: 'cap-title', tabindex: '-1' })
  const headEl = h('div', { class: 'tp-side-head' }, titleEl)
  const emptyListEl = h('p', { class: 'help cap-empty' })
  const sideEl = h('nav', { class: 'tp-side cap-side' })
  const groups = new Map<'active' | 'paused', GroupEntry>()
  const rows = new Map<string, RowEntry>()

  let currentScheduleId: string | null = null
  let currentPaused = false
  const detailTitle = h('h2', { class: 'tp-title' })
  const detailStatus = h('span', { class: 'tp-status' })
  const detailPrompt = h('p', { class: 'fu-ask' })
  const detailHow = h('p', { class: 'fu-note' })
  const pauseBtn = h('button', {
    class: 'btn btn-secondary',
    type: 'button',
    onClick: () => { if (currentScheduleId) handlers.pauseSchedule(currentScheduleId, !currentPaused) },
  }) as HTMLButtonElement
  const deleteBtn = h('button', {
    class: 'btn btn-text',
    type: 'button',
    onClick: () => { if (currentScheduleId) handlers.deleteSchedule(currentScheduleId) },
  }) as HTMLButtonElement
  const detailError = h('p', { class: 'form-error', role: 'alert' })
  const detailScroll = h('div', { class: 'tp-scroll fu-scroll' })
  const detailMain = h('div', { class: 'tp-main' })

  const emptyMessage = h('p', { class: 'help' })
  const emptyError = h('p', { class: 'form-error', role: 'alert' })
  const emptyMain = h('div', { class: 'tp-main tp-empty' })

  function update(container: HTMLElement, state: State, now: number) {
    const activeEl = document.activeElement
    const hadFocusInside = Boolean(activeEl && container.contains(activeEl))
    const previousId = currentScheduleId

    const navLabel = t('schedules-page.title')
    sideEl.setAttribute('aria-label', navLabel)
    if (titleEl.textContent !== navLabel) titleEl.textContent = navLabel

    const grouped = scheduleGroups(state)
    const shownId = shownScheduleId(state)
    const groupLabels: Record<'active' | 'paused', string> = {
      active: t('schedules-page.upcoming'),
      paused: t('schedules-page.paused.group'),
    }
    const initialLoading = !state.schedules.loaded && Boolean(state.schedules.loading)
    const present = new Set<string>()
    const sideChildren: HTMLElement[] = [headEl]
    if (grouped.length === 0) {
      emptyListEl.textContent = t(initialLoading ? 'earlier.loading' : 'schedules-page.list.empty')
      sideChildren.push(emptyListEl)
    } else {
      for (const { key, items } of grouped) {
        let group = groups.get(key)
        if (!group) {
          const label = document.createTextNode('')
          const count = h('span', { class: 'tp-group-count' })
          group = { el: h('div', { class: 'tp-group' }, label, count), label, count }
          groups.set(key, group)
        }
        group.label.data = groupLabels[key]
        group.count.textContent = String(items.length)
        sideChildren.push(group.el)
        for (const schedule of items) {
          present.add(schedule.id)
          let row = rows.get(schedule.id)
          if (!row) {
            const id = schedule.id
            const name = h('span', { class: 'tp-name' })
            const meta = h('span', { class: 'tp-meta' })
            const el = h('button', {
              class: 'tp-row fu-row',
              type: 'button',
              onClick: () => handlers.selectSchedule(id),
            }, name, meta) as HTMLButtonElement
            row = { el, name, meta }
            rows.set(id, row)
          }
          row.el.dataset.status = schedule.status
          if (schedule.id === shownId) row.el.setAttribute('aria-current', 'page')
          else row.el.removeAttribute('aria-current')
          if (row.name.textContent !== schedule.title) row.name.textContent = schedule.title
          const standing = scheduleStanding(schedule, now)
          if (row.meta.textContent !== standing) row.meta.textContent = standing
          sideChildren.push(row.el)
        }
      }
    }
    reconcileChildren(sideEl, sideChildren)
    for (const id of rows.keys()) if (!present.has(id)) rows.delete(id)

    const picked = selectedSchedule(state)
    let main: HTMLElement
    if (picked) {
      currentScheduleId = picked.id
      currentPaused = picked.status === 'paused'
      detailMain.dataset.schedule = picked.id
      if (detailTitle.textContent !== picked.title) detailTitle.textContent = picked.title
      const statusText = `${KIND_NAMES[picked.kind] ?? picked.kind} · ${scheduleStanding(picked, now)}`
      if (detailStatus.textContent !== statusText) detailStatus.textContent = statusText
      if (detailPrompt.textContent !== picked.prompt) detailPrompt.textContent = picked.prompt
      const howText = t('schedules-page.how')
      if (detailHow.textContent !== howText) detailHow.textContent = howText
      const busy = Boolean(state.schedules.busy)
      pauseBtn.textContent = currentPaused ? t('schedules-page.resume') : t('schedules-page.pause')
      pauseBtn.disabled = busy
      deleteBtn.textContent = t('schedules-page.delete')
      deleteBtn.disabled = busy
      const head = detailMain.querySelector<HTMLElement>('header.tp-head')
        ?? h('header', { class: 'tp-head' }, maidFor(scheduleMaids, 'schedule', 'idle', { size: MAID_PX }), detailTitle, detailStatus)
      const actions = detailScroll.querySelector<HTMLElement>('.fu-actions')
        ?? h('div', { class: 'confirm-actions fu-actions' }, pauseBtn, deleteBtn)
      const scrollChildren: HTMLElement[] = [detailPrompt, detailHow, actions]
      if (state.schedules.error) {
        detailError.textContent = state.schedules.error
        scrollChildren.push(detailError)
      }
      reconcileChildren(detailScroll, scrollChildren)
      reconcileChildren(detailMain, [head, detailScroll])
      main = detailMain
    } else {
      currentScheduleId = null
      const emptyChildren: HTMLElement[] = []
      if (initialLoading) {
        emptyMessage.textContent = t('earlier.loading')
        emptyChildren.push(emptyMessage)
      } else if (state.schedules.loaded || !state.schedules.error) {
        const gone = Boolean(state.schedules.loaded && state.schedules.explicit && state.schedules.selected)
        emptyMessage.textContent = t(gone ? 'schedules-page.gone' : 'schedules-page.empty')
        emptyChildren.push(emptyMessage)
      }
      if (state.schedules.error) {
        emptyError.textContent = state.schedules.error
        emptyChildren.push(emptyError)
      }
      reconcileChildren(emptyMain, emptyChildren)
      main = emptyMain
    }

    reconcileChildren(container, [sideEl, main])

    if (hadFocusInside && previousId && !present.has(previousId) && !container.contains(document.activeElement)) {
      const fallback = (shownId ? rows.get(shownId)?.el : undefined) ?? titleEl
      queueLayout(container, () => () => fallback.focus())
    }
  }

  return { update }
}

const renderedViews = new WeakMap<HTMLElement, { handlers: Handlers, view: ReturnType<typeof createSchedulesView> }>()

export function renderSchedulesPage(container: HTMLElement, state: State, handlers: Handlers, now = Date.now()) {
  container.dataset.open = String(state.schedules.open)
  if (!state.schedules.open) {
    renderedViews.delete(container)
    container.replaceChildren()
    return
  }
  let entry = renderedViews.get(container)
  if (!entry || entry.handlers !== handlers) {
    entry = { handlers, view: createSchedulesView(handlers) }
    renderedViews.set(container, entry)
  }
  entry.view.update(container, state, now)
}
