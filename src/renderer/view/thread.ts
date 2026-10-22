import { fileName, splitFiles } from '../../shared/attachments.ts'
import { optionName } from '../approval.ts'
import { PROMPT_HEADS, permissionCard as cardOf, promptButtons } from '../prompt-card.ts'
import { catMood, currentAction, receiptLine, restoredNote } from '../selectors.ts'
import { catFor } from './cat.ts'
import { h, label } from './dom.ts'
import { caretHost, renderMarkdown } from './markdown.ts'
import { foldAfter, rewindTarget } from '../rewind-state.ts'
import { offeredBackground } from '../tasks-state.ts'
import { cardedTasks, taskCard } from './task-card.ts'
import { sentPictures } from './pictures.ts'
import { editorFocus, foldStrip, restoreEditorFocus, rewindBar, rewindEditor } from './rewind.ts'

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
    sentPictures(message.images),
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

const STILL = Object.freeze({ latest: false, mood: 'idle' })

/** A search hit is found by its message's row (timeline-search.js); a view may be several elements, or none. */
export function markMessage(view, id) {
  const first = Array.isArray(view) ? view[0] : view
  first?.setAttribute('data-msg', id)
  return view
}

/**
 * A message from an earlier part of the timeline (view/earlier.js): as it was shown, fully typed out, its
 * receipt as plain text (its trace belongs to a session no longer on screen).
 * @param {{ id: string, role: string, text: string, receipt: object | null }} message
 */
export function pastMessageView(message, handlers) {
  if (message.role === 'user') return userView(message)
  if (message.role === 'note') return h('div', { class: 'msg-note' }, h('span', { text: message.text }))
  return h('div', { class: 'msg-agent' },
    avatar(message, STILL),
    h('div', { class: 'msg-body' },
      answerText(message, handlers),
      message.receipt ? h('span', { class: 'receipt receipt-static', text: receiptLine(message.receipt) }) : null))
}

/** A card's buttons by role (prompt-card.js); the island draws the same roles at its own size. */
const BUTTON = Object.freeze({ primary: 'btn btn-primary', secondary: 'btn btn-secondary', text: 'btn btn-text' })

const cardHead = (text) => h('div', { class: 'confirm-head' }, h('span', { text }), h('span', { class: 'pulse-dot' }))

/** The conversation's request; a background task's is asked on its card (view/task-card.js). */
function permissionCard(permission, handlers) {
  const head = PROMPT_HEADS.permission
  const { title, detail } = cardOf(permission)
  return h('section', { class: 'confirm', 'aria-label': head },
    cardHead(head),
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
  const head = PROMPT_HEADS.question
  const single = question.questions.length === 1 && !question.questions[0].multiSelect
  return h('section', { class: 'confirm ask', 'aria-label': head },
    cardHead(head),
    question.questions.map((item) => questionItem(item, question, handlers)),
    h('div', { class: 'confirm-actions' },
      single ? null : h('button', { class: `${BUTTON.primary} ask-submit`, text: '提交', onClick: () => handlers.submitAnswer() }),
      h('button', { class: `${BUTTON.text} ask-skip`, text: '跳过', onClick: () => handlers.skipQuestion() }),
      h('span', { class: 'confirm-hint', text: '也可以直接在下面输入你的回答' })))
}

/** A task Viva was closed on: offered once more, to go on in the background or be let go. */
function unfinishedCard(task, handlers) {
  return h('div', { class: 'task-report task-unfinished', role: 'group', 'aria-label': '上次没做完' },
    h('div', { class: 'task-report-main' },
      h('b', { class: 'task-report-head', text: `#${task.title}` }),
      h('span', { class: 'task-report-text', text: '上次关掉 Viva 时这件还没做完' })),
    h('button', { class: `${BUTTON.primary} task-report-open`, type: 'button', text: '接着做', onClick: () => handlers.resumeUnfinished(task.id) }),
    h('button', { class: `${BUTTON.text} task-report-open`, type: 'button', text: '不做了', onClick: () => handlers.forgetUnfinished(task.id) }))
}

/** The agent said the turn will take long (E): 放到后台 beside it, while it runs. Not a card: it asks nothing. */
function offerRow(state, handlers) {
  const offered = offeredBackground(state)
  if (!offered) return ''
  return h('div', { class: 'offer', role: 'note' },
    h('span', { class: 'offer-text', text: offered.why ? `这件要一会儿：${offered.why}。放到后台，你先忙别的？` : '这件要一会儿。放到后台，你先忙别的？' }),
    h('button', { class: `${BUTTON.secondary} offer-act`, type: 'button', text: '放到后台', onClick: () => handlers.moveToBackground() }))
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

const dimmed = (view) => [view].flat().filter(Boolean).map((el) => {
  el.classList.add('rewind-dim')
  return el
})

/**
 * A message with what going back adds to it: over the user's words the bar to go back there (or the editor, in
 * place, with what would fold after it dimmed), and after it the paths folded where it went another way.
 */
function messageEntries(state, views, handlers) {
  const editing = state.messages.findIndex((message) => message.id === state.rewind.editing)
  const later = editing < 0 ? 0 : state.messages.length - editing - 1
  const folds = foldAfter(state)
  return state.messages.map((message, i) => {
    let view = views[i]
    if (i === editing) view = markMessage(rewindEditor(message, handlers, later), message.id)
    else if (editing >= 0 && i > editing) view = dimmed(view)
    else if (message.role === 'user' && rewindTarget(state, message.id)) {
      // The bar beside the bubble, not in it: the bubble's text and place stay what they were.
      const [bubble, ...notes] = [view].flat().filter(Boolean)
      view = markMessage([h('div', { class: 'msg-user-row' }, rewindBar(message, handlers), bubble), ...notes], message.id)
    }
    const strip = (fold) => foldStrip(fold, { opened: state.rewind.open[fold.id], handlers, messageView: (past) => pastMessageView(past, handlers), tasks: state.tasks })
    const strips = (folds[message.id] ?? []).flatMap(strip)
    const before = i === 0 ? (folds[''] ?? []).flatMap(strip) : []
    return [...before, ...[view].flat(), ...strips]
  })
}

/** Conversation column: only user text, assistant text, receipts, the confirmation card and the agent's question. */
export function renderThread(container, state, handlers, now) {
  const last = state.messages[state.messages.length - 1]
  const note = restoredNote(state, now)
  const traceReady = state.restoredTrace === 'loaded'
  // The answer after the latest question; none while the agent has not started on it.
  const latestAnswer = last?.role === 'assistant' ? last.id : null
  const mood = catMood(state)
  const plain = state.messages.map((message) => markMessage(MESSAGE_VIEWS[message.role]?.(message, handlers, traceReady, { latest: message.id === latestAnswer, mood }) ?? null, message.id))
  // A background task's card goes under the words that started it (后台做); one moved there mid-turn, at the end.
  const cards = new Map(cardedTasks(state).map(({ task, report }) => [task.id, taskCard(task, report, handlers, now)]))
  const views = messageEntries(state, plain, handlers).map((entries, i) => {
    const card = cards.get(state.messages[i].taskId)
    if (!card) return entries
    cards.delete(state.messages[i].taskId)
    return [...entries, card]
  })
  const focus = editorFocus()
  container.replaceChildren(
    ...(note ? views.toSpliced(state.restored.count, 0, historyDivider(note)) : views).flat().filter(Boolean),
    ...state.tasks.unfinished.map((task) => unfinishedCard(task, handlers)),
    ...cards.values(),
    offerRow(state, handlers),
    state.permission ? permissionCard(state.permission, handlers) : '',
    state.question ? questionCard(state.question, handlers) : '',
    state.secret ? secretCard(state.secret, handlers) : '',
    state.phase === 'working' && !last?.open ? workingRow(state) : '',
    state.phase === 'error' ? errorRow(state.error) : '',
  )
  restoreEditorFocus(focus, state.rewind.editing)
}
