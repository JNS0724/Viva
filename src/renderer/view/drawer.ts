import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { traceItems, usageLabel } from '../selectors.ts'
import { filesView } from './files-panel.ts'
import { h, label } from './dom.ts'
import { icon } from './icons.ts'
import { drawerScrollPlan, scrollSnapshot } from './scroll-follow.ts'
import { queueLayout, reconcileChildren } from './reconcile.ts'

let TABS = [
  { id: 'trace', name: t("drawer.activity") },
  { id: 'files', name: t("drawer.files") },
]

const empty = (text: string) => h('div', { class: 'empty', text })

let RESTORED_TRACE_NOTES: Readonly<Record<string, string>> = {
  loading: t("drawer.reading.earlier.activity.from.dsh.logs"),
  unavailable: t("drawer.earlier.activity.is.unavailable.dsh.logs.may"),
}

type TraceItem = ReturnType<typeof traceItems>[number]
const traceRows = new WeakMap<HTMLElement, Map<string, { item: TraceItem, node: HTMLElement }>>()

function traceView(state: State, body: HTMLElement): View[] {
  const items = traceItems(state)
  const usage = usageLabel(state.usage)
  const note = RESTORED_TRACE_NOTES[state.restoredTrace]
  const previous = traceRows.get(body)
  const next = new Map<string, { item: TraceItem, node: HTMLElement }>()
  const rows = items.map(item => {
    const cached = previous?.get(item.key)
    const node = cached && cached.item.title === item.title && cached.item.detail === item.detail
      && cached.item.time === item.time && cached.item.tone === item.tone ? cached.node
      : h('li', { class: 'trace-row' },
        h('span', { class: 'trace-rail' }, h('span', { class: 'dot', 'data-tone': item.tone }), h('span', { class: 'line' })),
        h('div', { class: 'trace-main' },
          h('div', { class: 'row-between' },
            h('span', { class: 'trace-title', text: item.title }),
            h('span', { class: 'trace-time', text: item.time })),
          item.detail ? h('div', { class: 'trace-detail', text: item.detail }) : null))
    next.set(item.key, { item, node })
    return node
  })
  traceRows.set(body, next)
  const list = body.querySelector<HTMLOListElement>(':scope > .trace') ?? h('ol', { class: 'trace' })
  reconcileChildren(list, rows)
  const noteNode = body.querySelector<HTMLElement>(':scope > .trace-note') ?? h('div', { class: 'trace-note' })
  if (noteNode.textContent !== (note ?? '')) noteNode.textContent = note ?? ''
  const usageNode = body.querySelector<HTMLElement>(':scope > .label') ?? label('')
  if (usageNode.textContent !== usage) usageNode.textContent = usage
  return [
    note ? noteNode : null,
    usage ? usageNode : null,
    items.length ? list : empty(t("drawer.the.assistant.s.thoughts.and.tool.calls")),
  ]
}

type DrawerView = {
  body: HTMLElement, tabs: HTMLButtonElement[], close: HTMLButtonElement,
  handlers: Handlers, scroll: ReturnType<typeof scrollSnapshot>,
  fileScroll: { tree: number, preview: { path: string | undefined, top: number } | null } | null,
}
const drawers = new WeakMap<HTMLElement, DrawerView>()

function createDrawer(container: HTMLElement, handlers: Handlers): DrawerView {
  const view: DrawerView = {
    handlers, scroll: null, fileScroll: null,
    body: h('div', { class: 'drawer-body', role: 'tabpanel' }),
    tabs: TABS.map(tab => h('button', { class: 'tab', role: 'tab', onClick: () => view.handlers.openDrawer(tab.id) })),
    close: h('button', { class: 'icon-btn' }, icon('close', 16)),
  }
  view.close.addEventListener('click', () => view.handlers.closeDrawer())
  const yieldToReader = () => {
    view.scroll = { tab: container.dataset.tab ?? '', top: view.body.scrollTop, atBottom: false }
  }
  view.body.addEventListener('wheel', event => { if (event.deltaY < 0) yieldToReader() }, { passive: true })
  view.body.addEventListener('keydown', event => {
    if (!event.isComposing && event.keyCode !== 229 && ['ArrowUp', 'PageUp', 'Home'].includes(event.key)) yieldToReader()
  })
  view.body.addEventListener('scroll', () => {
    if (!view.scroll) return
    const next = scrollSnapshot(view.body, container.dataset.tab ?? '')!
    // Keep following through the subpixel clamping of our own bottom write at fractional DPI.
    if (next.tab === view.scroll?.tab && (next.top === view.scroll.top
      || view.scroll.atBottom && Math.abs(next.top - view.scroll.top) <= 2)) return
    if (view.scroll?.tab === next.tab && next.top < view.scroll.top) next.atBottom = false
    view.scroll = next
  }, { passive: true })
  container.append(h('div', { class: 'drawer-head' }, h('div', { class: 'tabs', role: 'tablist' }, view.tabs), view.close), view.body)
  drawers.set(container, view)
  return view
}

/** Right-hand drawer, opened from the title bar: the trace and the files the agent touched. */
export function renderDrawer(container: HTMLElement, state: State, handlers: Handlers) {
  container.dataset.open = String(Boolean(state.drawer))
  if (!state.drawer) {
    container.dataset.tab = ''
    container.replaceChildren()
    drawers.delete(container)
    return
  }
  const view = drawers.get(container) ?? createDrawer(container, handlers)
  view.handlers = handlers
  if (container.dataset.tab !== state.drawer) {
    view.scroll = null
    view.fileScroll = null
  }
  if (!state.timeline.length) view.scroll = null
  view.tabs.forEach((button, index) => {
    const tab = TABS[index]
    if (button.textContent !== tab.name) button.textContent = tab.name
    const selected = String(tab.id === state.drawer)
    if (button.getAttribute('aria-selected') !== selected) button.setAttribute('aria-selected', selected)
  })
  const closeLabel = t('drawer.close.panel')
  if (view.close.getAttribute('aria-label') !== closeLabel) view.close.setAttribute('aria-label', closeLabel)
  // The 文件 tab scrolls inside: its tree, and its preview while the same file is shown.
  if (state.drawer === 'files' && !view.fileScroll) {
    const shown = view.body.querySelector<HTMLElement>('.file-preview[data-path]')
    view.fileScroll = {
      tree: view.body.querySelector('.file-tree')?.scrollTop ?? 0,
      preview: shown ? { path: shown.dataset.path, top: shown.scrollTop } : null,
    }
  }
  const content = state.drawer === 'files' ? filesView(state, handlers) : traceView(state, view.body)
  reconcileChildren(view.body, content.filter((node): node is Node | string => node !== null && node !== undefined && node !== false))
  container.dataset.tab = state.drawer
  const tab = state.drawer
  queueLayout(view.body, () => {
    if (!view.body.isConnected || container.dataset.open !== 'true' || container.dataset.tab !== tab) return
    const plan = drawerScrollPlan(view.scroll, tab)
    const bottom = plan.stickToBottom ? Math.max(0, view.body.scrollHeight - view.body.clientHeight) : null
    return () => {
      if (bottom !== null && drawerScrollPlan(view.scroll, tab).stickToBottom) {
        view.scroll = { tab, top: bottom, atBottom: true }
        view.body.scrollTop = bottom
      }
      const savedFiles = view.fileScroll
      if (!savedFiles) return
      const treeNow = view.body.querySelector('.file-tree')
      if (treeNow) treeNow.scrollTop = savedFiles.tree
      const previewNow = view.body.querySelector<HTMLElement>('.file-preview[data-path]')
      if (previewNow && savedFiles.preview && previewNow.dataset.path === savedFiles.preview.path) previewNow.scrollTop = savedFiles.preview.top
      view.fileScroll = null
    }
  })
}

onLocaleChange(() => {
  TABS = [
  { id: 'trace', name: t("drawer.activity") },
  { id: 'files', name: t("drawer.files") },
]
  RESTORED_TRACE_NOTES = {
  loading: t("drawer.reading.earlier.activity.from.dsh.logs"),
  unavailable: t("drawer.earlier.activity.is.unavailable.dsh.logs.may"),
}
})
