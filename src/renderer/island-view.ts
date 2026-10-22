import { optionName } from './approval.ts'
import { PROMPT_HEADS, permissionCard, promptButtons } from './prompt-card.ts'
import { catMood, currentAction, traceItems, truncate } from './selectors.ts'
import { liveTasks, offeredBackground, spinOffTarget } from './tasks-state.ts'

/**
 * What the Viva island shows, for both of its hosts: the capsule in the window's title bar (view/island.js)
 * and the island on the desktop while the window is in the background (desk.js). Plain data, so it can go
 * to the desktop island's window over IPC; the hosts decide how much of it to show.
 */

/** Steps the expanded island lists. */
const RECENT_STEPS = 4
const DETAIL_LIMIT = 60
const PREVIEW_LIMIT = 40

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
  /** The task it speaks for, when a task (not the conversation) has the island. */
  task?: string,
  movable?: boolean, offered?: boolean,
  permission?: IslandPermission,
  question?: IslandQuestion,
  background?: IslandBackground,
}
type IslandBase = Pick<IslandView, 'mood' | 'recent'>

const recentSteps = (state: State): IslandStep[] => traceItems(state).slice(-RECENT_STEPS).map(({ title, tone }: IslandStep) => ({ title, tone }))

/** The first line of an answer as plain text: what the island shows of it once the turn is done. */
export function answerPreview(text: unknown) {
  const line = String(text ?? '').split('\n').map((item) => item.trim()).find(Boolean) ?? ''
  const plain = line
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
    .replace(/[*_`~]/g, '')
    .trim()
  return truncate(plain, PREVIEW_LIMIT)
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

function lastAnswer(state: State) {
  const message = state.messages.findLast((item: ThreadMessage) => item.role === 'assistant')
  return message ? answerPreview(message.text) : ''
}

function afterTurn(state: State, base: IslandBase): IslandView {
  const receipt = state.lastReceipt
  if (receipt.stopReason === 'cancelled') return { ...base, form: 'idle', tone: 'idle', label: '已停止', detail: state.info.model || '' }
  return { ...base, form: 'done', tone: 'done', label: '已完成', elapsedMs: receipt.ms, detail: lastAnswer(state) }
}

/**
 * Tasks in the background (tasks-state.js), those that wait on the user first: how many go on, how many ended
 * (still there until closed, so the 后台 page stays a click away), and a line each for when the island opens.
 * null with none, so the island is as it always was.
 */
function backgroundOf(state: State): IslandBackground | null {
  const live: BackgroundTask[] = liveTasks(state)
  if (!state.tasks.list.length && !state.tasks.finished) return null
  const items: IslandTask[] = live
    .toSorted((a, b) => Number(b.status === 'waiting') - Number(a.status === 'waiting'))
    .map((task) => ({
      id: task.id, title: task.title, status: task.status, now: task.now, startedAt: task.startedAt,
      ...(task.permission ? { permission: permissionView(task.permission) } : {}),
      ...(task.question ? { question: questionView(task.question) } : {}),
    }))
  const done = state.tasks.list.length - live.length
  return { count: live.length, waiting: live.filter((task) => task.status === 'waiting').length, done, items }
}

const TASK_ENDED: Readonly<Record<string, readonly [said: string, tone: string]>> = { done: ['做完了', 'done'], stopped: ['停下了', 'idle'], error: ['出错了', 'error'] }

export function islandView(state: State): IslandView {
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
 * (then the task takes the whole island, named), or a task has just ended while it is quiet.
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
    return { ...base, form: 'asking', tone: 'waiting', label: PROMPT_HEADS.secret, question: { questionId: requestId, id: 'secret', text: `接入「${server}」需要你填写密钥`, options: [] } }
  }
  if (state.phase === 'asking' && state.question) {
    return { ...base, form: 'asking', tone: 'waiting', label: PROMPT_HEADS.question, question: questionView(state.question) }
  }
  if (state.phase === 'working') {
    return {
      ...base, form: 'working', tone: 'working', label: '工作中',
      action: currentAction(state), startedAt: state.turn?.startedAt ?? null, steps: state.turn?.tools ?? 0,
      // A turn that runs a while is offered the background (D, view/island-dom.js); at once when the agent said it would (E).
      ...(spinOffTarget(state) ? { movable: true } : {}),
      ...(offeredBackground(state) ? { offered: true } : {}),
    }
  }
  if (state.phase === 'error') return { ...base, form: 'error', tone: 'error', label: '出错', detail: truncate(state.error, DETAIL_LIMIT) }
  const finished = state.tasks.finished
  if (finished) {
    const [said, tone] = TASK_ENDED[finished.status] ?? TASK_ENDED.done
    const form = tone === 'error' ? 'error' : 'done'
    return { ...base, mood: tone === 'idle' ? 'idle' : form, form, tone, label: `#${finished.title} ${said}`, task: finished.title }
  }
  if (state.info.mode === 'connecting') return { ...base, form: 'pending', tone: 'pending', label: '连接中' }
  if (state.info.mode === 'setup') return { ...base, form: 'pending', tone: 'pending', label: '未连接' }
  if (state.lastReceipt) return afterTurn(state, base)
  return { ...base, form: 'idle', tone: 'idle', label: '空闲', detail: state.info.model || '' }
}
