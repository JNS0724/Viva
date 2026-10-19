import { fileItems, traceItems, usageLabel, webItems } from '../selectors.js'
import { h, label } from './dom.js'
import { icon } from './icons.js'
import { drawerScrollPlan, scrollSnapshot } from './scroll-follow.js'

const TABS = [
  { id: 'trace', name: '过程', icon: 'trace' },
  { id: 'files', name: '文件', icon: 'file' },
  { id: 'web', name: '网页', icon: 'globe' },
  { id: 'mail', name: '邮件', icon: 'mail' },
]

const empty = (text) => h('div', { class: 'empty', text })

const stat = (variant, caption, value) => h('div', { class: `stat stat-${variant}` },
  label(caption),
  h('span', { class: 'dot-num', text: String(value).padStart(2, '0') }))

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
    h('div', { class: 'stat-grid' },
      stat('white', '01 / TOOLS', Object.keys(state.tools).length),
      stat('dark', '02 / THOUGHTS', state.thoughts.length)),
    h('div', { class: 'row-between' }, label('TRACE · 思考与工具调用只在这里'), usage ? label(usage) : null),
    items.length
      ? h('ol', { class: 'trace' }, items.map((item) => h('li', { class: 'trace-row' },
        h('span', { class: 'trace-rail' }, h('span', { class: 'dot', 'data-tone': item.tone }), h('span', { class: 'line' })),
        h('div', { class: 'trace-main' },
          h('div', { class: 'row-between' },
            h('span', { class: 'trace-title', text: item.title }),
            h('span', { class: 'trace-time', text: item.time })),
          item.detail ? h('div', { class: 'trace-detail', text: item.detail }) : null))))
      : empty('发起一个任务后，助手的思考、读写的文件、调用的工具都会按时间排在这里。'),
  ]
}

function filesView(state) {
  const files = fileItems(state)
  return [
    h('div', { class: 'stat stat-accent' }, label('FILES TOUCHED'), h('span', { class: 'dot-num', text: String(files.length).padStart(2, '0') })),
    files.length
      ? files.map((file) => h('div', { class: 'list-row', title: file.path },
        h('span', { class: 'dot', 'data-tone': file.tone }),
        h('span', { class: 'grow', text: file.name }),
        h('span', { class: 'mono muted', text: file.kind })))
      : empty('助手读写过的文件会出现在这里。'),
  ]
}

function webView(state) {
  const pages = webItems(state)
  return pages.length
    ? pages.map((page) => h('div', { class: 'list-row', title: page.url },
      h('span', { class: 'dot', 'data-tone': page.tone }),
      h('span', { class: 'grow' }, h('span', { class: 'block', text: page.title }), h('span', { class: 'block mono muted', text: page.url })),
      icon('globe', 16)))
    : [empty('助手抓取的网页会出现在这里。后续可以在这一栏嵌入实时网页画面，并提供「我来接管」。')]
}

function mailView() {
  return [
    h('div', { class: 'stat stat-dark' }, label('MAIL · 尚未接入'), h('span', { class: 'tile-big', text: '邮件' })),
    empty('邮件可以通过 MCP 服务器接入（在 session/new 的 mcpServers 里声明）。接入后，读取和发送邮件会作为工具调用出现在「过程」里，发送前会弹出确认卡片。'),
  ]
}

const TAB_VIEWS = { trace: traceView, files: filesView, web: webView, mail: mailView }

function rail(state, handlers) {
  return h('nav', { class: 'rail', 'aria-label': '工具' }, TABS.map((tab) => h('button', {
    class: 'icon-btn rail-btn',
    'aria-label': tab.name,
    title: tab.name,
    onClick: () => handlers.openDrawer(tab.id),
  }, icon(tab.icon, 20), tab.id === 'trace' && state.phase === 'waiting' ? h('span', { class: 'rail-dot' }) : null)))
}

/** Right-hand drawer: an icon rail when closed, tabbed tool panels when open. */
export function renderDrawer(container, state, handlers) {
  container.dataset.open = String(Boolean(state.drawer))
  if (!state.drawer) {
    container.dataset.tab = ''
    container.replaceChildren(rail(state, handlers))
    return
  }
  const before = scrollSnapshot(container.querySelector('.drawer-body'), container.dataset.tab)
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
}
