import { localeRevision } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { fileName, splitFiles } from '../../shared/attachments.ts'
import { optionName } from '../approval.ts'
import { PROMPT_HEADS, permissionCard as cardOf, promptButtons } from '../prompt-card.ts'
import { catMood, currentAction, receiptLine, restoredNote } from '../selectors.ts'
import type { CatMood } from '../selectors.ts'
import { catFor } from './cat.ts'
import { h, label } from './dom.ts'
import { caretHost, renderMarkdown } from './markdown.ts'
import { canRewindMessage, foldAfter } from '../rewind-state.ts'
import { reconcileChildren } from './reconcile.ts'
import { offeredBackground } from '../tasks-state.ts'
import { cardedTasks, taskCard } from './task-card.ts'
import { sentPictures } from './pictures.ts'
import { editorFocus, foldStrip, restoreEditorFocus, rewindBar, rewindEditor } from './rewind.ts'
import { proposalCard } from './followups.ts'

const AVATAR_CAT_PX = 36

/** Whether a message is the answer of the turn in progress or just finished, and what the cat is doing. */
type CatSlots = Map<string, { key: string, el: HTMLElement }>
type Look = { latest: boolean, mood: CatMood | 'idle', cats?: CatSlots }
const containerCats = new WeakMap<HTMLElement, CatSlots>()

/** A small cat on its disc beside each answer: the latest one shows what the agent does now, earlier ones rest. */
const avatar = (message: ThreadMessage, look: Look) => h('span', { class: 'cat-avatar', 'aria-hidden': 'true' },
  catFor(look.cats ?? new Map(), message.id, look.latest ? look.mood : 'idle', { size: AVATAR_CAT_PX, frame: true, still: !look.latest }))

/** Moods the cat leaves for `typing` while the answer is still being typed out, the agent's own turn over or not. */
const WRITES_OVER = new Set(['idle', 'thinking', 'done'])

/** A restored message links to the trace only once it has been read back from dsh's logs. */
function receiptButton(message: ThreadMessage & { receipt: Receipt }, handlers: Handlers, traceReady: boolean) {
  if (message.restored && !traceReady) return h('span', { class: 'receipt receipt-static', text: receiptLine(message.receipt) })
  return h('button', { class: 'receipt', onClick: () => handlers.openDrawer('trace') },
    t("thread.view.activity", { value1: receiptLine(message.receipt) }))
}

function historyDivider(note: { when: string, memory: string }) {
  return h('div', { class: 'history-divider', role: 'separator' },
    h('span', { class: 'history-when', text: t("thread.earlier.messages", { when: note.when }) }),
    note.memory ? h('span', { text: note.memory }) : null)
}

/** Cut at `shown` without splitting a surrogate pair (emoji, rare CJK). */
function visibleText(text: string, shown: number | undefined) {
  const end = Math.min(shown ?? text.length, text.length)
  const code = text.charCodeAt(end - 1)
  return text.slice(0, code >= 0xD800 && code <= 0xDBFF ? end + 1 : end)
}

/** Row caching below owns nodes per container. The same message may be visible in several views. */
function answerText(message: ThreadMessage, handlers: Handlers): HTMLElement {
  const text = visibleText(message.text, message.shown)
  const el = renderMarkdown(text, { openLink: handlers.openLink })
  return el
}

const hasReceipt = (message: ThreadMessage): message is ThreadMessage & { receipt: Receipt } => Boolean(message.receipt)

function assistantView(message: ThreadMessage, handlers: Handlers, traceReady: boolean, look: Look) {
  const typing = message.open || (message.shown ?? message.text.length) < message.text.length
  const text = answerText(message, handlers)
  text.querySelector('.caret')?.remove()
  if (typing) caretHost(text).append(h('span', { class: 'caret', 'aria-hidden': 'true' }))
  // A request or an error still shows; otherwise the cat types as long as the words come out.
  const mood = typing && WRITES_OVER.has(look.mood) ? 'typing' : look.mood
  return h('div', { class: 'msg-agent' },
    avatar(message, { ...look, mood }),
    h('div', { class: 'msg-body' },
      text,
      hasReceipt(message) && !typing ? receiptButton(message, handlers, traceReady) : null))
}

const fileChip = (filePath: string) => h('span', { class: 'msg-file', title: filePath }, h('span', { class: 'doc-ico', 'aria-hidden': 'true' }), fileName(filePath))

/**
 * A question with the files handed over with it (attachments.js): the files as chips above the text, and
 * below it where it came from (the desktop island), whether it was said while the agent worked, and
 * whether it failed to get through.
 */
function askedView(message: ThreadMessage): View {
  const { text, files } = splitFiles(message.text)
  const bubble = h('div', { class: 'msg-user' },
    sentPictures(message.images),
    files.length ? h('div', { class: 'msg-files' }, files.map(fileChip)) : null,
    text)
  const notes = [message.steered && t("thread.sent.during.work"), message.via === 'island' && t("thread.sent.from.viva.island"), message.failed && t("thread.not.delivered")].filter(Boolean)
  if (!notes.length) return bubble
  return [bubble, h('div', { class: `msg-via${message.failed ? ' msg-via-failed' : ''}`, text: notes.join(' · ') })]
}

/** A reply to the agent's question shows what it answers. */
const userView = (message: ThreadMessage): View => (message.asked
  ? h('div', { class: 'msg-user msg-answer' }, h('div', { class: 'msg-asked', text: message.asked }), h('div', { text: message.text }))
  : askedView(message))

const MESSAGE_VIEWS: Readonly<Record<string, (message: ThreadMessage, handlers: Handlers, traceReady: boolean, look: Look) => View>> = {
  user: userView,
  assistant: assistantView,
  note: (message, handlers, traceReady) => h('div', { class: 'msg-note' },
    h('span', { text: message.text }),
    hasReceipt(message) ? receiptButton(message, handlers, traceReady) : null),
}

const STILL: Look = Object.freeze({ latest: false, mood: 'idle' })

/** A search hit is found by its message's row (timeline-search.js); a view may be several elements, or none. */
export function markMessage<T extends View>(view: T, id: string): T {
  const first = Array.isArray(view) ? view[0] : view
  if (first instanceof Element) first.setAttribute('data-msg', id)
  return view
}

/**
 * A message from an earlier part of the timeline (view/earlier.js): as it was shown, fully typed out, its
 * receipt as plain text (its trace belongs to a session no longer on screen).
 */
export function pastMessageView(message: ThreadMessage, handlers: Handlers): View {
  if (message.role === 'user') return userView(message)
  if (message.role === 'note') return h('div', { class: 'msg-note' }, h('span', { text: message.text }))
  return h('div', { class: 'msg-agent' },
    avatar(message, STILL),
    h('div', { class: 'msg-body' },
      answerText(message, handlers),
      message.receipt ? h('span', { class: 'receipt receipt-static', text: receiptLine(message.receipt) }) : null))
}

/** A card's buttons by role (prompt-card.js); the island draws the same roles at its own size. */
const BUTTON: Readonly<Record<string, string>> = Object.freeze({ primary: 'btn btn-primary', secondary: 'btn btn-secondary', text: 'btn btn-text' })

const cardHead = (text: string) => h('div', { class: 'confirm-head' }, h('span', { text }), h('span', { class: 'pulse-dot' }))

/** The conversation's request; a background task's is asked on its card (view/task-card.js). */
function permissionCard(permission: NonNullable<State['permission']>, handlers: Handlers) {
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
      h('span', { class: 'confirm-hint', text: t("thread.risky.actions.require.your.approval") })))
}

/** The agent's question as the state keeps it: its questions, and what is picked so far for each. */
type AskedQuestion = { questions: readonly QuestionItem[], picks: Readonly<Record<string, readonly string[] | undefined>> }

function questionItem(item: QuestionItem, question: AskedQuestion, handlers: Handlers) {
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
function questionCard(question: AskedQuestion, handlers: Handlers) {
  const head = PROMPT_HEADS.question
  const single = question.questions.length === 1 && !question.questions[0].multiSelect
  return h('section', { class: 'confirm ask', 'aria-label': head },
    cardHead(head),
    question.questions.map((item) => questionItem(item, question, handlers)),
    h('div', { class: 'confirm-actions' },
      single ? null : h('button', { class: `${BUTTON.primary} ask-submit`, text: t("thread.submit"), onClick: () => handlers.submitAnswer() }),
      h('button', { class: `${BUTTON.text} ask-skip`, text: t("island-dom.skip"), onClick: () => handlers.skipQuestion() }),
      h('span', { class: 'confirm-hint', text: t("thread.you.can.also.type.your.answer.below") })))
}

/**
 * A task Viva was closed on: offered once more, to go on in the background or be let go. 接着做 waits for the
 * agent to be connected: until then the main process has no session to take the task up in.
 */
function unfinishedCard(task: { id: string, title: string }, handlers: Handlers, ready: boolean) {
  return h('div', { class: 'task-report task-unfinished', role: 'group', 'aria-label': t("thread.unfinished.from.last.time") },
    h('div', { class: 'task-report-main' },
      h('b', { class: 'task-report-head', text: `#${task.title}` }),
      h('span', { class: 'task-report-text', text: t("thread.this.task.was.unfinished.when.viva.closed") })),
    h('button', {
      class: `${BUTTON.primary} task-report-open`, type: 'button', text: t("followups.continue"), disabled: !ready,
      title: ready ? null : t("thread.connect.the.assistant.to.continue"), onClick: () => handlers.resumeUnfinished(task.id),
    }),
    h('button', { class: `${BUTTON.text} task-report-open`, type: 'button', text: t("thread.abandon"), onClick: () => handlers.forgetUnfinished(task.id) }))
}

/** The agent said the turn will take long (E): 放到后台 beside it, while it runs. Not a card: it asks nothing. */
function offerRow(state: State, handlers: Handlers) {
  const offered = offeredBackground(state)
  if (!offered) return ''
  return h('div', { class: 'offer', role: 'note' },
    h('span', { class: 'offer-text', text: offered.why ? t("thread.this.will.take.a.while.move.it", { why: offered.why }) : t("island-dom.this.will.take.a.while.move.it") }),
    h('button', { class: `${BUTTON.secondary} offer-act`, type: 'button', text: t("island-dom.move.to.background"), onClick: () => handlers.moveToBackground() }))
}

const workingCats = new Map<string, { key: string, el: HTMLElement }>()

/** Where the next answer will appear: the cat at work and what it is doing now (the island keeps the time). */
function workingRow(state: State) {
  return h('div', { class: 'msg-working', role: 'status' },
    h('span', { class: 'cat-avatar', 'aria-hidden': 'true' }, catFor(workingCats, 'working', catMood(state), { size: AVATAR_CAT_PX, frame: true })),
    h('span', { class: 'msg-working-text', text: `${currentAction(state)}…` }))
}

function errorRow(message: string) {
  return h('div', { class: 'msg-error', role: 'alert' },
    label(t("island-view.something.went.wrong")),
    h('div', { text: message }),
    h('div', { class: 'muted', text: t("thread.check.the.model.key.api.address.network") }))
}

let secretForm: { requestId: string, el: HTMLFormElement } | null = null

/**
 * Keys a server the model set up needs. The form is kept while the same request waits, since the thread is
 * rebuilt on every frame and would otherwise lose what was typed.
 */
function secretCard(secret: { requestId: string, server: string, names: readonly string[] }, handlers: Handlers) {
  if (secretForm && secretForm.requestId === secret.requestId) return secretForm.el
  const inputs = secret.names.map((name) => h('input', {
    class: 'field', type: 'password', name: `secret-${name}`, autocomplete: 'off', spellcheck: 'false', 'aria-label': name, placeholder: name,
  }))
  const el = h('form', {
    class: 'confirm ask secret', 'aria-label': t("thread.credentials.needed"),
    onSubmit: (event: SubmitEvent) => {
      event.preventDefault()
      handlers.submitSecrets(Object.fromEntries(secret.names.map((name, i) => [name, inputs[i].value])))
    },
  },
  cardHead(PROMPT_HEADS.secret),
  h('div', { class: 'confirm-title', text: t("thread.connecting.requires.these.credentials", { server: secret.server }) }),
  secret.names.map((name, i) => h('label', { class: 'secret-field' }, h('span', { class: 'secret-name', text: name }), inputs[i])),
  h('div', { class: 'confirm-actions' },
    h('button', { class: BUTTON.primary, type: 'submit', text: t("extensions.save") }),
    h('button', { class: BUTTON.secondary, type: 'button', text: t("thread.do.not.connect"), onClick: () => handlers.declineSecrets() }),
    h('span', { class: 'confirm-hint', text: t("thread.encrypted.on.this.computer.never.sent.to") })))
  secretForm = { requestId: secret.requestId, el }
  return el
}

/** The elements of a view, one level down, without the empty parts. */
const elementsOf = (view: View): Element[] => [view].flat().filter((el): el is Element => el instanceof Element)

/**
 * A message with what going back adds to it: over the user's words the bar to go back there (or the editor, in
 * place, with what would fold after it dimmed), and after it the paths folded where it went another way.
 */
function messageEntries(state: State, views: readonly View[], handlers: Handlers): View[][] {
  const editing = state.messages.findIndex((message) => message.id === state.rewind.editing)
  const later = editing < 0 ? 0 : state.messages.length - editing - 1
  const folds = foldAfter(state)
  return state.messages.map((message, i) => {
    let view = views[i]
    if (i === editing) view = markMessage(rewindEditor(message, handlers, later), message.id)
    else {
      for (const el of elementsOf(view)) el.classList.toggle('rewind-dim', editing >= 0 && i > editing)
      const bar = elementsOf(view)[0]?.querySelector<HTMLElement>('.rewind-bar')
      if (bar) bar.hidden = !canRewindMessage(state, message)
    }
    const strip = (fold: Untyped) => foldStrip(fold, { opened: state.rewind.open[fold.id], handlers, messageView: (past: ThreadMessage) => pastMessageView(past, handlers), tasks: state.tasks })
    const strips = (folds[message.id] ?? []).flatMap(strip)
    const before = i === 0 ? (folds[''] ?? []).flatMap(strip) : []
    return [...before, ...[view].flat(), ...strips]
  })
}

/** What can go into an element: nodes and text; the empty parts of a view are left out. */
const isContent = (part: unknown): part is Node | string => part instanceof Node || (typeof part === 'string' && part !== '')

type CachedView = { inputs: readonly unknown[], view: View }
const threadViews = new WeakMap<HTMLElement, Map<string, CachedView>>()
const sameInputs = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, i) => value === b[i])

/** Cache each row independently, so a new prompt or a streamed chunk never detaches old messages. */
function cachedView(cache: Map<string, CachedView>, key: string, inputs: readonly unknown[], build: () => View): View {
  inputs = [localeRevision(), ...inputs]
  const previous = cache.get(key)
  if (previous && sameInputs(previous.inputs, inputs)) return previous.view
  const view = build()
  cache.set(key, { inputs, view })
  return view
}

function messageInputs(message: ThreadMessage, traceReady: boolean, look: Look) {
  return [message.role, message.text, message.shown, message.open, message.receipt, message.images,
    message.asked, message.steered, message.via, message.failed, message.restored,
    message.role === 'assistant' && look.latest, message.role === 'assistant' && look.latest ? look.mood : null,
    message.role === 'user' ? null : traceReady]
}

function messageView(message: ThreadMessage, handlers: Handlers, traceReady: boolean, look: Look): View {
  const view = MESSAGE_VIEWS[message.role]?.(message, handlers, traceReady, look) ?? null
  if (message.role !== 'user' || message.asked) return markMessage(view, message.id)
  const [bubble, ...notes] = elementsOf(view)
  // The tools never participate in bubble sizing; busy/idle changes only their visibility.
  return markMessage([h('div', { class: 'msg-user-row' }, rewindBar(message, handlers), bubble), ...notes], message.id)
}

/** Conversation column: only user text, assistant text, receipts, the confirmation card and the agent's question. */
export function renderThread(container: HTMLElement, state: State, handlers: Handlers, now: number) {
  const cats = containerCats.get(container) ?? new Map()
  containerCats.set(container, cats)
  const messageIds = new Set(state.messages.map(message => message.id))
  for (const id of cats.keys()) if (!messageIds.has(id)) cats.delete(id)
  const previous = threadViews.get(container) ?? new Map<string, CachedView>()
  const cache = new Map<string, CachedView>()
  const part = (key: string, inputs: readonly unknown[], build: () => View) => {
    const view = cachedView(previous, key, inputs, build)
    cache.set(key, previous.get(key)!)
    return view
  }
  const last = state.messages[state.messages.length - 1]
  const note = restoredNote(state, now)
  const traceReady = state.restoredTrace === 'loaded'
  // The answer after the latest question; none while the agent has not started on it.
  const latestAnswer = last?.role === 'assistant' ? last.id : null
  const mood = catMood(state)
  const plain = state.messages.map((message) => {
    const look = { latest: message.id === latestAnswer, mood, cats }
    return part(`message:${message.id}`, messageInputs(message, traceReady, look), () => messageView(message, handlers, traceReady, look))
  })
  // A background task's card goes under the words that started it (后台做), or under the message that was last when
  // it started (moved there mid-turn); it moves with the conversation. One with neither here is not this one's.
  const cards = new Map(cardedTasks(state).map(({ task, report }) => [task.id,
    part(`task:${task.id}`, [task, report, Math.floor(now / 60_000)], () => taskCard(task, report, handlers, now))]))
  const views = messageEntries(state, plain, handlers).map((entries, i) => {
    const hosted = [state.messages[i].taskId, ...(state.messages[i].cardsAfter ?? [])].flatMap((id) => {
      const card = id ? cards.get(id) : undefined
      if (!card || !id) return []
      cards.delete(id)
      return [card]
    })
    return hosted.length ? [...entries, ...hosted] : entries
  })
  const focus = editorFocus()
  const nodes = [
    ...state.taskCards.flatMap(id => cards.get(id) ?? []),
    ...(note ? views.toSpliced(state.restored.count, 0, [part('divider', [note.when, note.memory], () => historyDivider(note))]) : views).flat().filter(isContent),
    ...state.tasks.unfinished.map((task) => part(`unfinished:${task.id}`, [task, state.info.mode], () => unfinishedCard(task, handlers, state.info.mode === 'live'))),
    ...state.tasks.submissions.map(item => part(`submission:${item.id}`, [item], () => h('section', { class: 'task-submission' },
      h('b', { class: 'task-name', text: item.text }),
      h('div', { class: 'task-submit-status', role: 'status', text: item.status === 'failed' ? t("thread.not.started.in.background", { problem: item.problem ?? '' }) : t("thread.received.preparing.background.task") }),
      item.status === 'failed' ? h('div', {},
        h('button', { class: 'btn btn-outline btn-small', type: 'button', text: t("thread.retry"), onClick: () => handlers.retrySubmission(item.id) }),
        h('button', { class: 'btn btn-outline btn-small', type: 'button', text: t("extensions.remove"), onClick: () => handlers.dismissSubmission(item.id) })) : null))),
    state.tasks.moving ? part('moving', [], () => h('div', { role: 'status', text: t("thread.moving.to.background") })) : '',
    // The follow-ups the model proposed in this conversation, each to be decided on (view/followups.ts).
    ...state.proposals.map((card: Untyped) => part(`proposal:${card.id}`, [card], () => proposalCard(card, handlers, now))),
    part('offer', [offeredBackground(state)?.why ?? null], () => offerRow(state, handlers)),
    state.permission ? part('permission', [state.permission], () => permissionCard(state.permission!, handlers)) : '',
    state.question ? part('question', [state.question], () => questionCard(state.question, handlers)) : '',
    state.secret ? secretCard(state.secret, handlers) : '',
    state.phase === 'working' && !last?.open ? part('working', [catMood(state), currentAction(state)], () => workingRow(state)) : '',
    state.phase === 'error' ? part('error', [state.error], () => errorRow(state.error)) : '',
  ].flat().filter(isContent)
  const changed = reconcileChildren(container, nodes)
  threadViews.set(container, cache)
  restoreEditorFocus(focus, state.rewind.editing)
  return changed
}
