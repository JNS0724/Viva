import { t } from '../shared/i18n/translate.ts'
import { PROMPT_HEADS, formatElapsed } from './selectors.ts'
import { userError } from './user-error.ts'

/**
 * What a card of the desktop island says and offers (view/island-dom.ts draws it), as plain data. A card says each
 * thing once: its head says the state (需要你确认), its body what it is about (运行命令 …), never the head again.
 * Each action is offered once: when a button below opens the window, the head carries no ↗ as well.
 */

export type DeskAction = { kind: string, [field: string]: unknown }
/** By role, as on the thread's cards (prompt-card.ts): primary is the colour of waiting; blue the accent's. */
export type DeskRole = 'primary' | 'blue' | 'secondary' | 'text'
export interface DeskButton { text: string, role: DeskRole, act: DeskAction, push?: boolean, external?: boolean }
export type DeskPart =
  | { kind: 'title', text: string }
  | { kind: 'text', text: string, clamp?: boolean }
  | { kind: 'code', text: string }
  | { kind: 'hint', text: string }
  | { kind: 'choices', options: ReadonlyArray<{ text: string, act: DeskAction }> }
  | { kind: 'background' }
export interface DeskCard {
  label: string
  /** A few words beside the state: how long it took, whose request it is, what is missing. */
  meta: string
  /** The head offers to open the window: nothing below does. */
  openIcon: boolean
  /** What its × does. */
  close: DeskAction
  body: DeskPart[]
  actions: DeskButton[]
}

const DISMISS: DeskAction = Object.freeze({ kind: 'dismiss' })
const OPEN: DeskAction = Object.freeze({ kind: 'open' })
const ROLES = new Set<DeskRole>(['primary', 'secondary', 'text'])

const card = (label: string, fields: Partial<DeskCard> = {}): DeskCard => ({ label, meta: '', openIcon: false, close: DISMISS, body: [], actions: [], ...fields })
const fromTask = (view: IslandShown) => (view.task ? t('desk-card.from.task', { task: view.task }) : '')
const askMore = (): DeskButton => ({ text: t('desk.interaction.continue'), role: 'text', act: { kind: 'input' } })

function permissionCard(view: IslandShown): DeskCard {
  const { permission } = view
  return card(view.label, {
    meta: fromTask(view), openIcon: true,
    body: [{ kind: 'title', text: permission.title }, ...(permission.command ? [{ kind: 'code' as const, text: permission.command }] : [])],
    actions: permission.options.map((option: { optionId: string, name: string, role: string }) => ({
      text: option.name, role: ROLES.has(option.role as DeskRole) ? option.role as DeskRole : 'secondary',
      act: { kind: 'permission', requestId: permission.requestId, optionId: option.optionId },
    })),
  })
}

function questionCard(view: IslandShown): DeskCard {
  const { question } = view
  const skip: DeskButton[] = question.skippable ? [{ text: t('island-dom.skip'), role: 'text', act: { kind: 'skip', questionId: question.questionId }, push: true }] : []
  const meta = fromTask(view) || question.header || ''
  const open = view.taskId ? { kind: 'task', taskId: view.taskId } : OPEN
  if (!question.options.length) {
    // Nothing to tap here (a secret, several questions, several choices): the window is the one way on.
    const text = t(question.id === 'secret' ? 'desk-card.fill.in.viva' : 'desk-card.answer.in.viva')
    return card(view.label, { meta, body: [{ kind: 'title', text: question.text }], actions: [{ text, role: 'primary', act: open }, ...skip] })
  }
  return card(view.label, {
    meta,
    body: [
      { kind: 'title', text: question.text },
      { kind: 'hint', text: t('desk.interaction.immediate.answer') },
      { kind: 'choices', options: question.options.map((label: string) => ({ text: label, act: { kind: 'answer', questionId: question.questionId, id: question.id, label } })) },
    ],
    actions: [{ text: t('desk.interaction.other.answer'), role: 'text', act: open, external: true }, ...skip],
  })
}

function doneCard(view: IslandShown): DeskCard {
  const reply = view.summary || view.detail
  return card(view.label, {
    meta: view.elapsedMs ? t('desk-card.took', { elapsed: formatElapsed(view.elapsedMs) }) : '',
    body: reply ? [{ kind: 'text', text: reply, clamp: true }] : [],
    actions: [{ text: t('desk-card.view.reply'), role: 'blue', act: OPEN }, askMore()],
  })
}

function errorCard(view: IslandShown): DeskCard {
  const detail = view.detail ? (view.incomplete ? view.detail : userError(view.detail)) : ''
  return card(view.label, {
    body: detail ? [{ kind: 'text', text: detail }] : [],
    actions: [{ text: t(view.incomplete ? 'desk-card.view.reply' : 'desk-card.view.in.viva'), role: 'blue', act: OPEN }, ...(view.stopUnconfirmed ? [] : [askMore()])],
  })
}

/** Not connected: what is missing, and the way to it. Connecting: only that it is. */
function pendingCard(view: IslandShown): DeskCard {
  return card(view.label, {
    meta: view.detail ?? '', openIcon: !view.detail,
    actions: view.detail ? [{ text: t('selectors.open.settings'), role: 'blue', act: { kind: 'settings' } }] : [],
  })
}

function backgroundCard(view: IslandShown): DeskCard {
  return card(t('desk-card.background', { count: view.background?.count ?? 0 }), {
    meta: '',
    body: [{ kind: 'background' }],
    actions: [{ text: t('desk-card.open.tasks'), role: 'text', act: { kind: 'tasks' }, external: true }],
  })
}

/** @returns the card for a form, or null for the input and files dragged over, which the input draws itself */
export function deskCard(view: IslandShown, _options?: { shortcut?: string }): DeskCard | null {
  switch (view.form) {
    case 'waiting': return view.permission ? permissionCard(view) : null
    case 'asking': return view.question ? questionCard(view) : null
    case 'done': return doneCard(view)
    case 'error': return errorCard(view)
    case 'pending': return pendingCard(view)
    case 'background': return backgroundCard(view)
    case 'input':
    case 'switching':
    case 'drop': return null
    default: return card(view.label, { openIcon: true })
  }
}

/** What Esc does on the island as shown: the same as its ×. */
export const escapeAction = (_view?: IslandShown): DeskAction => ({ ...DISMISS })

const requestIdOf = (view: IslandShown): string | null => view.permission?.requestId ?? view.question?.questionId ?? null

/**
 * Every request the island could show: the conversation's own, then each task's that waits on the user. A task's
 * request has its own head and face, as island-view.ts gives it, never those of what the conversation shows meanwhile.
 */
function requestsOf(view: IslandShown): IslandShown[] {
  const tasks = (view.background?.items ?? []).filter((item: IslandShown) => item.permission || item.question).map((item: IslandShown) => item.permission
    ? { ...view, form: 'waiting', tone: 'waiting', mood: 'confirm', label: PROMPT_HEADS.permission, task: item.title, taskId: item.id, permission: item.permission, question: null }
    : { ...view, form: 'asking', tone: 'waiting', mood: 'ask', label: PROMPT_HEADS.question, task: item.title, taskId: item.id, permission: null, question: item.question })
  return [...(requestIdOf(view) ? [view] : []), ...tasks]
}

/** The request with this id as the island now has it, if it still waits. */
export const requestFor = (view: IslandShown, id: string | null): IslandShown | undefined => requestsOf(view).find(request => requestIdOf(request) === id)

/**
 * After the request a card shows was answered (here or in the window): null while it still waits, the next request
 * waiting otherwise, or undefined with none left, and the card folds.
 */
export function nextRequest(view: IslandShown, id: string | null): IslandShown | null | undefined {
  if (requestFor(view, id)) return null
  return requestsOf(view)[0]
}
