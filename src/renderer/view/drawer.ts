import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { traceItems, usageLabel } from '../selectors.ts'
import { filesView } from './files-panel.ts'
import { h, label } from './dom.ts'
import { icon } from './icons.ts'
import { drawerScrollPlan, scrollSnapshot } from './scroll-follow.ts'
import { queueLayout, reconcileChildren } from './reconcile.ts'
import { renderTraceDetail, type TraceItem, type DetailHandlers } from './trace-detail.ts'

let TABS = [
  { id: 'trace', name: t("drawer.activity") },
  { id: 'files', name: t("drawer.files") },
]

const empty = (text: string) => h('div', { class: 'empty', text })

let RESTORED_TRACE_NOTES: Readonly<Record<string, string>> = {
  loading: t("drawer.reading.earlier.activity.from.dsh.logs"),
  unavailable: t("drawer.earlier.activity.is.unavailable.dsh.logs.may"),
}

const traceRows = new WeakMap<HTMLElement, Map<string, { item: TraceItem, node: HTMLElement }>>()

export function traceNode(item: TraceItem, handlers: Handlers): HTMLElement {
  return h('li', { class: 'trace-row' },
    h('span', { class: 'trace-rail' }, h('span', { class: 'dot', 'data-tone': item.tone }), h('span', { class: 'line' })),
    h('button', { class: 'trace-main trace-node', type: 'button', 'data-trace-key': item.key,
      'aria-label': t('trace.open.node', { title: item.title }), onClick: () => handlers.openTraceDetail(item) },
      h('span', { class: 'row-between' },
        h('span', { class: 'trace-title', text: item.title }),
        h('span', { class: 'trace-time', text: item.time })),
      item.detail ? h('span', { class: 'trace-detail', text: item.detail }) : null))
}

const detailViews = new WeakMap<HTMLElement, { key: string, detail: State['traceDetail'], source: unknown, text: string, node: HTMLElement }>()
function detailNode(body: HTMLElement, state: State, item: TraceItem, handlers: Handlers) {
  const entry = item.entry
  const source = entry.kind === 'model' ? state.modelCalls[entry.ref] : entry.kind === 'tool' ? state.tools[entry.ref]
    : entry.kind === 'thought' ? state.thoughts.find(thought => thought.id === entry.ref) : entry
  const text = `${item.title}\n${item.detail}`
  const previous = detailViews.get(body)
  if (previous && previous.key === item.key && previous.detail === state.traceDetail && previous.source === source && previous.text === text) return previous.node
  const node = renderTraceDetail(state, item, handlers as DetailHandlers)
  detailViews.set(body, { key: item.key, detail: state.traceDetail, source, text, node })
  return node
}

function traceView(state: State, body: HTMLElement, handlers: Handlers): View[] {
  const items = traceItems(state)
  const selected = state.traceDetail ? items.find(item => item.key === state.traceDetail!.key) : null
  if (state.traceDetail && selected) return [detailNode(body, state, selected, handlers)]
  const usage = usageLabel(state.usage)
  const note = RESTORED_TRACE_NOTES[state.restoredTrace]
  const previous = traceRows.get(body)
  const next = new Map<string, { item: TraceItem, node: HTMLElement }>()
  const rows = items.map(item => {
    const cached = previous?.get(item.key)
    const node = cached && cached.item.title === item.title && cached.item.detail === item.detail
      && cached.item.time === item.time && cached.item.tone === item.tone ? cached.node
      : traceNode(item, handlers)
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
  request: HTMLElement, requestLabel: HTMLElement, requestButton: HTMLButtonElement,
  handlers: Handlers, scroll: ReturnType<typeof scrollSnapshot>,
  fileScroll: { tree: number, preview: { path: string | undefined, top: number } | null } | null,
  detailKey: string | null,
}
const drawers = new WeakMap<HTMLElement, DrawerView>()

function createDrawer(container: HTMLElement, handlers: Handlers): DrawerView {
  const requestLabel = h('span')
  const requestButton = h('button', { class: 'btn btn-primary btn-small', type: 'button' })
  const view: DrawerView = {
    handlers, scroll: null, fileScroll: null, detailKey: null,
    request: h('div', { class: 'drawer-request', hidden: true }, requestLabel, requestButton),
    requestLabel, requestButton,
    body: h('div', { class: 'drawer-body', role: 'tabpanel' }),
    tabs: TABS.map(tab => h('button', { class: 'tab', role: 'tab', onClick: () => view.handlers.openDrawer(tab.id) })),
    close: h('button', { class: 'icon-btn' }, icon('close', 16)),
  }
  view.close.addEventListener('click', () => view.handlers.closeDrawer())
  view.requestButton.addEventListener('click', () => view.handlers.jumpToRequest())
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
  container.append(h('div', { class: 'drawer-head' }, h('div', { class: 'tabs', role: 'tablist' }, view.tabs), view.close), view.request, view.body)
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
  view.request.hidden = !(state.permission || state.question || state.secret)
  const requestLabel = t('island-dom.needs.your.attention')
  const requestButton = t('drawer.open.request')
  if (view.requestLabel.textContent !== requestLabel) view.requestLabel.textContent = requestLabel
  if (view.requestButton.textContent !== requestButton) view.requestButton.textContent = requestButton
  // The 文件 tab scrolls inside: its tree, and its preview while the same file is shown.
  if (state.drawer === 'files' && !view.fileScroll) {
    const shown = view.body.querySelector<HTMLElement>('.file-preview[data-path]')
    view.fileScroll = {
      tree: view.body.querySelector('.file-tree')?.scrollTop ?? 0,
      preview: shown ? { path: shown.dataset.path, top: shown.scrollTop } : null,
    }
  }
  const content = state.drawer === 'files' ? filesView(state, handlers) : traceView(state, view.body, handlers)
  reconcileChildren(view.body, content.filter((node): node is Node | string => node !== null && node !== undefined && node !== false))
  const nextDetailKey = state.traceDetail?.key ?? null
  if (view.detailKey !== nextDetailKey) {
    const returnKey = view.detailKey
    view.detailKey = nextDetailKey
    if (nextDetailKey) view.body.querySelector<HTMLButtonElement>('.trace-back')?.focus()
    else if (returnKey) view.body.querySelector<HTMLButtonElement>(`[data-trace-key="${CSS.escape(returnKey)}"]`)?.focus()
  }
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
