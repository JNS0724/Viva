import { fileName, splitFiles } from '../../shared/attachments.js'
import { optionName } from '../approval.js'
import { PROMPT_HEADS, permissionCard as cardOf, promptButtons } from '../prompt-card.js'
import { catMood, currentAction, receiptLine, restoredNote } from '../selectors.js'
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
    `${receiptLine(message.receipt)} · 查看过程 →`)
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

const fileChip = (filePath) => h('span', { class: 'msg-file', title: filePath }, h('span', { class: 'doc-ico', 'aria-hidden': 'true' }), fileName(filePath))

/**
 * A question with the files handed over with it (attachments.js): the files as chips above the text, and
 * below it where it came from (the desktop island), whether it was said while the agent worked, and
 * whether it failed to get through.
 */
function askedView(message) {
  const { text, files } = splitFiles(message.text)
  const bubble = h('div', { class: 'msg-user' },
    files.length ? h('div', { class: 'msg-files' }, files.map(fileChip)) : null,
    text)
  const notes = [message.steered && '工作中插话', message.via === 'island' && '从 Viva 岛发送', message.failed && '没有送到'].filter(Boolean)
  if (!notes.length) return bubble
  return [bubble, h('div', { class: `msg-via${message.failed ? ' msg-via-failed' : ''}`, text: notes.join(' · ') })]
}

/** A reply to the agent's question shows what it answers. */
const userView = (message) => (message.asked
  ? h('div', { class: 'msg-user msg-answer' }, h('div', { class: 'msg-asked', text: message.asked }), h('div', { text: message.text }))
  : askedView(message))

const MESSAGE_VIEWS = {
  user: userView,
  assistant: assistantView,
  note: (message, handlers, traceReady) => h('div', { class: 'msg-note' },
    h('span', { text: message.text }),
    message.receipt ? receiptButton(message, handlers, traceReady) : null),
}

/** A card's buttons by role (prompt-card.js); the island draws the same roles at its own size. */
const BUTTON = Object.freeze({ primary: 'btn btn-primary', secondary: 'btn btn-secondary', text: 'btn btn-text' })

const cardHead = (text) => h('div', { class: 'confirm-head' }, h('span', { text }), h('span', { class: 'pulse-dot' }))

function permissionCard(permission, handlers) {
  const { title, detail } = cardOf(permission)
  return h('section', { class: 'confirm', 'aria-label': PROMPT_HEADS.permission },
    cardHead(PROMPT_HEADS.permission),
    h('div', { class: 'confirm-title', text: title }),
    detail ? h('pre', { class: 'confirm-detail', text: detail }) : null,
    h('div', { class: 'confirm-actions' },
      promptButtons(permission.options).map((option) => h('button', {
        class: BUTTON[option.role],
        text: optionName(option),
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
        class: `${picked.includes(option.label) ? BUTTON.primary : BUTTON.secondary} ask-option`,
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
    cardHead(PROMPT_HEADS.question),
    question.questions.map((item) => questionItem(item, question, handlers)),
    h('div', { class: 'confirm-actions' },
      single ? null : h('button', { class: `${BUTTON.primary} ask-submit`, text: '提交', onClick: () => handlers.submitAnswer() }),
      h('button', { class: `${BUTTON.text} ask-skip`, text: '跳过', onClick: () => handlers.skipQuestion() }),
      h('span', { class: 'confirm-hint', text: '也可以直接在下面输入你的回答' })))
}

const workingCats = new Map()

/** Where the next answer will appear: the cat at work and what it is doing now (the island keeps the time). */
function workingRow(state) {
  return h('div', { class: 'msg-working', role: 'status' },
    h('span', { class: 'cat-avatar', 'aria-hidden': 'true' }, catFor(workingCats, 'working', catMood(state), { size: AVATAR_CAT_PX, frame: true })),
    h('span', { class: 'msg-working-text', text: `${currentAction(state)}…` }))
}

function errorRow(message) {
  return h('div', { class: 'msg-error', role: 'alert' },
    label('出错了'),
    h('div', { text: message }),
    h('div', { class: 'muted', text: '检查模型的 key 和接口地址、网络，或查看终端日志。' }))
}

let secretForm = null

/**
 * Keys a server the model set up needs. The form is kept while the same request waits, since the thread is
 * rebuilt on every frame and would otherwise lose what was typed.
 */
function secretCard(secret, handlers) {
  if (secretForm?.requestId === secret.requestId) return secretForm.el
  const inputs = secret.names.map((name) => h('input', {
    class: 'field', type: 'password', name: `secret-${name}`, autocomplete: 'off', spellcheck: 'false', 'aria-label': name, placeholder: name,
  }))
  const el = h('form', {
    class: 'confirm ask secret', 'aria-label': '需要你填写密钥',
    onSubmit: (event) => {
      event.preventDefault()
      handlers.submitSecrets(Object.fromEntries(secret.names.map((name, i) => [name, inputs[i].value])))
    },
  },
  cardHead(PROMPT_HEADS.secret),
  h('div', { class: 'confirm-title', text: `接入「${secret.server}」需要这些密钥` }),
  secret.names.map((name, i) => h('label', { class: 'secret-field' }, h('span', { class: 'secret-name', text: name }), inputs[i])),
  h('div', { class: 'confirm-actions' },
    h('button', { class: BUTTON.primary, type: 'submit', text: '保存' }),
    h('button', { class: BUTTON.secondary, type: 'button', text: '不接入', onClick: () => handlers.declineSecrets() }),
    h('span', { class: 'confirm-hint', text: '加密保存在这台电脑上，不会发给模型' })))
  secretForm = { requestId: secret.requestId, el }
  return el
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
    ...(note ? views.toSpliced(state.restored.count, 0, historyDivider(note)) : views).flat().filter(Boolean),
    state.permission ? permissionCard(state.permission, handlers) : '',
    state.question ? questionCard(state.question, handlers) : '',
    state.secret ? secretCard(state.secret, handlers) : '',
    state.phase === 'working' && !last?.open ? workingRow(state) : '',
    state.phase === 'error' ? errorRow(state.error) : '',
  )
}
