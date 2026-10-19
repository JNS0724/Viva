import { permissionDetail, receiptLine, restoredNote, statusView } from '../selectors.js'
import { h, label } from './dom.js'

const avatar = () => h('span', { class: 'orb-avatar', 'aria-hidden': 'true' })

/** A restored message links to the trace only once it has been read back from dsh's logs. */
function receiptButton(message, handlers, traceReady) {
  if (message.restored && !traceReady) return h('span', { class: 'receipt receipt-static', text: receiptLine(message.receipt) })
  return h('button', { class: 'receipt', onClick: () => handlers.openDrawer('trace') },
    `${receiptLine(message.receipt)} · VIEW TRACE →`)
}

function historyDivider(note) {
  return h('div', { class: 'history-divider', role: 'separator' },
    h('span', { class: 'history-when', text: `以上是历史消息 · ${note.when}` }),
    note.memory ? h('span', { text: note.memory }) : null)
}

/** Cut at `shown` without splitting a surrogate pair (emoji, rare CJK). */
function visibleText(text, shown) {
  const end = Math.min(shown ?? text.length, text.length)
  const code = text.charCodeAt(end - 1)
  return text.slice(0, code >= 0xD800 && code <= 0xDBFF ? end + 1 : end)
}

function assistantView(message, handlers, traceReady) {
  const typing = message.open || (message.shown ?? message.text.length) < message.text.length
  return h('div', { class: 'msg-agent' },
    avatar(),
    h('div', { class: 'msg-body' },
      h('p', { class: 'msg-text' }, visibleText(message.text, message.shown), typing ? h('span', { class: 'caret', 'aria-hidden': 'true' }) : null),
      message.receipt && !typing ? receiptButton(message, handlers, traceReady) : null))
}

const MESSAGE_VIEWS = {
  user: (message) => h('div', { class: 'msg-user', text: message.text }),
  assistant: assistantView,
  note: (message, handlers, traceReady) => h('div', { class: 'msg-note' },
    h('span', { text: message.text }),
    message.receipt ? receiptButton(message, handlers, traceReady) : null),
}

function permissionCard(permission, handlers) {
  const detail = permissionDetail(permission)
  return h('section', { class: 'confirm', 'aria-label': '需要你确认' },
    h('div', { class: 'confirm-head' },
      h('span', { text: `ACTION REQUIRED · ${permission.kind.toUpperCase()}` }),
      h('span', { class: 'pulse-dot' })),
    h('div', { class: 'confirm-title', text: permission.title }),
    detail ? h('pre', { class: 'confirm-detail', text: detail }) : null,
    h('div', { class: 'confirm-actions' },
      permission.options.map((option) => h('button', {
        class: option.kind.startsWith('allow') ? 'btn btn-ink' : 'btn btn-ghost-ink',
        text: option.name,
        onClick: () => handlers.respond(permission.requestId, option.optionId),
      })),
      h('span', { class: 'confirm-hint', text: '有风险的操作总会先问你' })))
}

function workingRow(state, now) {
  return h('div', { class: 'msg-working', role: 'status' },
    h('span', { class: 'typing' }, h('i'), h('i'), h('i')),
    h('span', { text: statusView(state, now).event }))
}

function errorRow(message) {
  return h('div', { class: 'msg-error', role: 'alert' },
    label('ERROR'),
    h('div', { text: message }),
    h('div', { class: 'muted', text: '检查 DEEPSEEK_API_KEY、网络，或查看启动 demo 的终端日志。' }))
}

/** Conversation column: only user text, assistant text, receipts and the confirmation card. */
export function renderThread(container, state, handlers, now) {
  const last = state.messages[state.messages.length - 1]
  const note = restoredNote(state, now)
  const traceReady = state.restoredTrace === 'loaded'
  const views = state.messages.map((message) => MESSAGE_VIEWS[message.role]?.(message, handlers, traceReady) ?? null)
  container.replaceChildren(
    ...(note ? views.toSpliced(state.restored.count, 0, historyDivider(note)) : views).filter(Boolean),
    state.permission ? permissionCard(state.permission, handlers) : '',
    state.phase === 'working' && !last?.open ? workingRow(state, now) : '',
    state.phase === 'error' ? errorRow(state.error) : '',
  )
}
