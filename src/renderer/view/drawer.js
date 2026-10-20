import { traceItems, usageLabel } from '../selectors.js'
import { filesView } from './files-panel.js'
import { h, label } from './dom.js'
import { icon } from './icons.js'
import { drawerScrollPlan, scrollSnapshot } from './scroll-follow.js'

const TABS = [
  { id: 'trace', name: '过程' },
  { id: 'files', name: '文件' },
]

const empty = (text) => h('div', { class: 'empty', text })

const RESTORED_TRACE_NOTES = {
  loading: '正在从 dsh 的日志里读取之前的过程…',
  unavailable: '之前的过程记录读取不到：dsh 的日志可能已被清理。对话内容不受影响。',
}

function traceView(state) {
  const items = traceItems(state)
  const usage = usageLabel(state.usage)
  const note = RESTORED_TRACE_NOTES[state.restoredTrace]
  return [
    note ? h('div', { class: 'trace-note', text: note }) : null,
    usage ? label(usage) : null,
    items.length
      ? h('ol', { class: 'trace' }, items.map((item) => h('li', { class: 'trace-row' },
        h('span', { class: 'trace-rail' }, h('span', { class: 'dot', 'data-tone': item.tone }), h('span', { class: 'line' })),
        h('div', { class: 'trace-main' },
          h('div', { class: 'row-between' },
            h('span', { class: 'trace-title', text: item.title }),
            h('span', { class: 'trace-time', text: item.time })),
          item.detail ? h('div', { class: 'trace-detail', text: item.detail }) : null))))
      : empty('助手的思考和用到的工具会按顺序出现在这里。'),
  ]
}

const TAB_VIEWS = { trace: traceView, files: filesView }

/** Right-hand drawer, opened from the title bar: the trace and the files the agent touched. */
export function renderDrawer(container, state, handlers) {
  container.dataset.open = String(Boolean(state.drawer))
  if (!state.drawer) {
    container.dataset.tab = ''
    container.replaceChildren()
    return
  }
  const before = scrollSnapshot(container.querySelector('.drawer-body'), container.dataset.tab)
  // The 文件 tab scrolls inside: its tree, and its preview while the same file is shown.
  const tree = container.querySelector('.file-tree')?.scrollTop ?? 0
  const shown = container.querySelector('.file-preview[data-path]')
  const preview = shown ? { path: shown.dataset.path, top: shown.scrollTop } : null
  container.replaceChildren(
    h('div', { class: 'drawer-head' },
      h('div', { class: 'tabs', role: 'tablist' }, TABS.map((tab) => h('button', {
        class: 'tab',
        role: 'tab',
        'aria-selected': String(tab.id === state.drawer),
        text: tab.name,
        onClick: () => handlers.openDrawer(tab.id),
      }))),
      h('button', { class: 'icon-btn', 'aria-label': '收起抽屉', onClick: handlers.closeDrawer }, icon('close', 16))),
    h('div', { class: 'drawer-body', role: 'tabpanel' }, (TAB_VIEWS[state.drawer] ?? traceView)(state, handlers)))
  const body = container.querySelector('.drawer-body')
  const plan = drawerScrollPlan(before, state.drawer)
  body.scrollTop = plan.stickToBottom ? body.scrollHeight : plan.top
  container.dataset.tab = state.drawer
  const treeNow = container.querySelector('.file-tree')
  if (treeNow) treeNow.scrollTop = tree
  const previewNow = container.querySelector('.file-preview[data-path]')
  if (previewNow && previewNow.dataset.path === preview?.path) previewNow.scrollTop = preview.top
}
