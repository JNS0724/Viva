import { catMood, permissionDetail, receiptLine, restoredNote, statusView } from '../selectors.js'
import { catFor } from './cat.js'
import { h, label } from './dom.js'
import { caretHost, renderMarkdown } from './markdown.js'

const AVATAR_CAT_PX = 36
/** While the agent waits on the user, the cat beside its answer holds up the same sign as the island's. */
const AVATAR_MOODS = new Set(['confirm', 'ask'])
const avatarCats = new Map()

/** A small cat on its disc beside each answer; only the one of the turn in progress or just finished moves. */
const avatar = (message, look) => h('span', { class: 'cat-avatar', 'aria-hidden': 'true' },
  catFor(avatarCats, message.id, look.latest && AVATAR_MOODS.has(look.mood) ? look.mood : 'idle', { size: AVATAR_CAT_PX, frame: true, still: !look.latest }))

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

/**
 * The thread is rebuilt on every frame while an answer types out; each answer is parsed again only when
 * its visible text changed. The element is reused as is (its links keep their handlers).
 */
const renderedAnswers = new Map()

function answerText(message, handlers) {
  const text = visibleText(message.text, message.shown)
  const cached = renderedAnswers.get(message.id)
  if (cached?.text === text) return cached.el
  const el = renderMarkdown(text, handlers)
  renderedAnswers.set(message.id, { text, el })
  return el
}

function assistantView(message, handlers, traceReady, look) {
  const typing = message.open || (message.shown ?? message.text.length) < message.text.length
  const text = answerText(message, handlers)
  text.querySelector('.caret')?.remove()
  if (typing) caretHost(text).append(h('span', { class: 'caret', 'aria-hidden': 'true' }))
  return h('div', { class: 'msg-agent' },
    avatar(message, look),
    h('div', { class: 'msg-body' },
      text,
      message.receipt && !typing ? receiptButton(message, handlers, traceReady) : null))
}

/** A reply to the agent's question shows what it answers. */
const userView = (message) => (message.asked
  ? h('div', { class: 'msg-user msg-answer' }, h('div', { class: 'msg-asked', text: message.asked }), h('div', { text: message.text }))
  : h('div', { class: 'msg-user', text: message.text }))

const MESSAGE_VIEWS = {
  user: userView,
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

function questionItem(item, question, handlers) {
  const picked = question.picks[item.id] ?? []
  return h('div', { class: 'ask-item' },
    item.header ? h('span', { class: 'ask-header', text: item.header }) : null,
    h('div', { class: 'ask-question', text: item.question }),
    item.options.length ? h('div', { class: 'ask-options', role: item.multiSelect ? 'group' : 'radiogroup', 'aria-label': item.question },
      item.options.map((option) => h('button', {
        class: picked.includes(option.label) ? 'btn btn-ink ask-option' : 'btn btn-ghost-ink ask-option',
        'aria-pressed': String(picked.includes(option.label)),
        title: option.description ?? null,
        text: option.label,
        onClick: () => handlers.pickOption(item.id, option.label),
      }))) : null)
}

/**
 * The agent's question, mid-turn. A single question with single choice is answered by its option; otherwise
 * picks are gathered and sent with 提交. Words typed in the composer (Enter) answer it too.
 */
function questionCard(question, handlers) {
  const single = question.questions.length === 1 && !question.questions[0].multiSelect
  return h('section', { class: 'confirm ask', 'aria-label': '助手在问你' },
    h('div', { class: 'confirm-head' },
      h('span', { text: 'QUESTION · 需要你回答' }),
      h('span', { class: 'pulse-dot' })),
    question.questions.map((item) => questionItem(item, question, handlers)),
    h('div', { class: 'confirm-actions' },
      single ? null : h('button', { class: 'btn btn-ink ask-submit', text: '提交', onClick: () => handlers.submitAnswer() }),
      h('button', { class: 'btn btn-ghost-ink ask-skip', text: '跳过', onClick: () => handlers.skipQuestion() }),
      h('span', { class: 'confirm-hint', text: '也可以直接在下面输入你的回答' })))
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
    h('div', { class: 'muted', text: '检查模型的 key 和接口地址、网络，或查看终端日志。' }))
}

/** Conversation column: only user text, assistant text, receipts, the confirmation card and the agent's question. */
export function renderThread(container, state, handlers, now) {
  const last = state.messages[state.messages.length - 1]
  const note = restoredNote(state, now)
  const traceReady = state.restoredTrace === 'loaded'
  // The answer after the latest question; none while the agent has not started on it.
  const latestAnswer = last?.role === 'assistant' ? last.id : null
  const mood = catMood(state)
  const views = state.messages.map((message) => MESSAGE_VIEWS[message.role]?.(message, handlers, traceReady, { latest: message.id === latestAnswer, mood }) ?? null)
  container.replaceChildren(
    ...(note ? views.toSpliced(state.restored.count, 0, historyDivider(note)) : views).filter(Boolean),
    state.permission ? permissionCard(state.permission, handlers) : '',
    state.question ? questionCard(state.question, handlers) : '',
    state.phase === 'working' && !last?.open ? workingRow(state, now) : '',
    state.phase === 'error' ? errorRow(state.error) : '',
  )
}
