import { t } from '../shared/i18n/translate.ts'
import { optionName } from './approval.ts'
import { PROMPT_HEADS, permissionCard, promptButtons } from './prompt-card.ts'
import { catMood, currentAction, setupProblem, traceTail, truncate } from './selectors.ts'
import { liveTasks, unseenEnded } from './tasks-state.ts'
import { turnProblem } from '../shared/turn-outcome.ts'

/**
 * What the Viva island shows, for both of its hosts: the capsule in the window's title bar (view/island.js)
 * and the island on the desktop while the window is in the background (desk.js). Plain data, so it can go
 * to the desktop island's window over IPC; the hosts decide how much of it to show.
 */

/** Steps the expanded island lists. */
const RECENT_STEPS = 4
const DETAIL_LIMIT = 60
const PREVIEW_LIMIT = 40
/** The desktop card reads the answer at more length than the head's one line (island-desk-card.ts). */
const SUMMARY_LIMIT = 120

type IslandForm = 'pending' | 'idle' | 'working' | 'waiting' | 'asking' | 'done' | 'error'
type IslandStep = { title: string, tone: string }
type IslandPermission = { requestId: string, title: string, command: string, options: Array<{ optionId: string, name: string, role: string }> }
type IslandQuestion = { questionId: string, id: string, header?: string, text: string, options: string[], skippable?: boolean }
/** A task in the background as the island lists it. */
type IslandTask = {
  id: string, title: string, status: string, now?: string | null, startedAt?: number,
  permission?: IslandPermission, question?: IslandQuestion,
}
type IslandBackground = { count: number, waiting: number, done: number, items: IslandTask[], alsoWaiting?: number }
export type IslandView = {
  form: IslandForm, tone: string, mood: string, label: string, recent: IslandStep[],
  detail?: string, action?: string | null, startedAt?: number | null, steps?: number, elapsedMs?: number,
  /** Done: the answer's first lines as plain text, for the desktop card's body. */
  summary?: string,
  /** An error that ended a turn with a reply kept in part (turn-outcome.ts), rather than a failure. */
  incomplete?: boolean,
  /** The task it speaks for, when a task (not the conversation) has the island. */
  task?: string,
  permission?: IslandPermission,
  question?: IslandQuestion,
  background?: IslandBackground,
  /** Background preparation: going now, and how many follow-ups are ready (view/island-tasks.ts tailCell). */
}
type IslandBase = Pick<IslandView, 'mood' | 'recent'>

const recentSteps = (state: State): IslandStep[] => traceTail(state, RECENT_STEPS).map(({ title, tone }: IslandStep) => ({ title, tone }))

/** A line of Markdown as plain text: no heading, quote or list mark, no emphasis. */
const plainLine = (line: string) => line.trim()
  .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
  .replace(/[*_`~]/g, '')
  .trim()
const answerLines = (text: unknown) => String(text ?? '').split('\n').map(plainLine).filter(Boolean)

/** The first line of an answer as plain text: what the island shows of it once the turn is done. */
export function answerPreview(text: unknown) {
  return truncate(answerLines(text)[0] ?? '', PREVIEW_LIMIT)
}

/** The answer's opening lines on one line as plain text: what the desktop card shows of it. */
export function answerSummary(text: unknown) {
  return truncate(answerLines(text).join(' '), SUMMARY_LIMIT)
}

/** The approval as the thread's card has it (prompt-card.js), with its command on one line instead of all its arguments. */
function permissionView(permission: Untyped): IslandPermission {
  const { title, command } = permissionCard(permission)
  return {
    requestId: permission.requestId,
    title,
    command,
    options: promptButtons(permission.options).map((option: PermissionOption & { role: string }) => ({ optionId: option.optionId, name: optionName(option), role: option.role })),
  }
}

/**
 * Only one question with one choice can be answered from the island; for anything else it opens the window.
 * Any question may be skipped from there, as from the thread.
 */
function questionView(question: { questionId: string, questions: readonly QuestionItem[] }): IslandQuestion {
  const [first] = question.questions
  const single = question.questions.length === 1 && !first.multiSelect
  return {
    questionId: question.questionId,
    id: first.id,
    ...(first.header ? { header: first.header } : {}),
    text: first.question,
    options: single ? first.options.map((option) => option.label) : [],
    skippable: true,
  }
}

const lastAnswerText = (state: State): string => state.messages.findLast((item: ThreadMessage) => item.role === 'assistant')?.text ?? ''

function afterTurn(state: State, base: IslandBase, background: IslandBackground | null): IslandView {
  const receipt = state.lastReceipt!
  if (receipt.stopReason === 'cancelled') return { ...base, form: 'idle', tone: 'idle', label: t("island-view.stopped"), detail: state.info.model || '' }
  const completed = state.completedTurn
  const awaitingResult = completed && state.tasks.list.some(task => task.status !== 'interrupted'
    && typeof task.endedAt === 'number' && task.endedAt >= completed.startedAt
    && !state.records.some(record => record.reportId === `${task.id}:${task.runId}` && record.at <= completed.endedAt))
  if (background?.count || awaitingResult) {
    const running = background?.items[0]
    return { ...base, recent: [], mood: 'thinking', form: 'working', tone: 'working',
      label: background?.count ? t('island-view.background.working') : t('island-view.preparing.result'),
      action: running?.now ?? running?.title ?? null, startedAt: running?.startedAt ?? completed?.startedAt ?? null, steps: 0 }
  }
  const problem = turnProblem(receipt.stopReason)
  if (problem) return { ...base, mood: 'error', form: 'error', tone: 'error', label: t('island-view.incomplete'), detail: problem, incomplete: true }
  const answer = lastAnswerText(state)
  return { ...base, form: 'done', tone: 'done', label: t("island-view.completed"), elapsedMs: receipt.ms, detail: answerPreview(answer), summary: answerSummary(answer) }
}

/**
 * Tasks in the background (tasks-state.js), those that wait on the user first: how many go on, how many ended
 * (still there until closed, so the 后台 page stays a click away), and a line each for when the island opens.
 * null with none, so the island is as it always was.
 */
function backgroundOf(state: State): IslandBackground | null {
  const live: BackgroundTask[] = liveTasks(state)
  if (!state.tasks.list.length) return null
  const items: IslandTask[] = live
    .toSorted((a, b) => Number(b.status === 'waiting') - Number(a.status === 'waiting'))
    .map((task) => ({
      id: task.id, title: task.title, status: task.status, now: task.now, startedAt: task.startedAt,
      ...(task.permission ? { permission: permissionView(task.permission) } : {}),
      ...(task.question ? { question: questionView(task.question) } : {}),
    }))
  // Ended and not yet seen: once opened on the 后台 page, no longer counted.
  const done = unseenEnded(state).length
  return { count: live.length, waiting: live.filter((task) => task.status === 'waiting').length, done, items }
}

export function islandView(state: State): IslandView {
  // The island speaks of what the user asked for only: follow-ups are 动态's (system-design §12.2).
  const background = backgroundOf(state)
  const view = mainView(state, background)
  if (!background) return view
  // Tasks that wait on the user beyond the one the island shows: said at its tail, so none is missed.
  const asks = view.form === 'waiting' || view.form === 'asking'
  const alsoWaiting = asks ? background.waiting - (view.task ? 1 : 0) : 0
  return { ...view, background: alsoWaiting > 0 ? { ...background, alsoWaiting } : background }
}

/**
 * What the island's head says: the conversation on screen, unless a task waits on the user and it does not
 * (then the task takes the whole island, named).
 */
function mainView(state: State, background: IslandBackground | null): IslandView {
  const base: IslandBase = { mood: catMood(state), recent: recentSteps(state) }
  if (state.phase === 'waiting' && state.permission) {
    return { ...base, form: 'waiting', tone: 'waiting', label: PROMPT_HEADS.permission, permission: permissionView(state.permission) }
  }
  if (state.phase !== 'asking') {
    const asking = background?.items.find((item) => item.permission || item.question)
    if (asking?.permission) {
      return { ...base, mood: 'confirm', form: 'waiting', tone: 'waiting', label: PROMPT_HEADS.permission, task: asking.title, permission: asking.permission }
    }
    if (asking?.question) return { ...base, mood: 'ask', form: 'asking', tone: 'waiting', label: PROMPT_HEADS.question, task: asking.title, question: asking.question }
  }
  if (state.phase === 'asking' && state.secret) {
    const { requestId, server } = state.secret
    return { ...base, form: 'asking', tone: 'waiting', label: PROMPT_HEADS.secret, question: { questionId: requestId, id: 'secret', text: t("island-view.enter.credentials.to.connect", { server: server }), options: [] } }
  }
  if (state.phase === 'asking' && state.question) {
    return { ...base, form: 'asking', tone: 'waiting', label: PROMPT_HEADS.question, question: questionView(state.question) }
  }
  if (state.phase === 'working') {
    return {
      ...base, form: 'working', tone: 'working', label: t("island-view.working"),
      action: currentAction(state), startedAt: state.turn?.startedAt ?? null, steps: state.turn?.tools ?? 0,
    }
  }
  if (state.phase === 'error') return { ...base, form: 'error', tone: 'error', label: t("island-view.error"), detail: truncate(state.error, DETAIL_LIMIT) }
  if (state.info.mode === 'connecting') return { ...base, form: 'pending', tone: 'pending', label: t("island-view.connecting") }
  if (state.info.mode === 'setup') return { ...base, form: 'pending', tone: 'pending', label: t("island-view.not.connected"), detail: setupProblem(state.info) }
  if (state.lastReceipt) return afterTurn(state, base, background)
  return { ...base, form: 'idle', tone: 'idle', label: t("island-view.idle"), detail: state.info.model || '' }
}
