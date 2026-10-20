import { optionName } from './approval.js'
import { catMood, currentAction, traceItems, truncate } from './selectors.js'

/**
 * What the Viva island shows, for both of its hosts: the capsule in the window's title bar (view/island.js)
 * and the island on the desktop while the window is in the background (desk.js). Plain data, so it can go
 * to the desktop island's window over IPC; the hosts decide how much of it to show.
 */

/** Steps the expanded island lists. */
const RECENT_STEPS = 4
const DETAIL_LIMIT = 60
const PREVIEW_LIMIT = 40

/**
 * @typedef {'pending' | 'idle' | 'working' | 'waiting' | 'asking' | 'done' | 'error'} IslandForm
 * @typedef {{ title: string, tone: string }} IslandStep
 * @typedef {{
 *   form: IslandForm, tone: string, mood: string, label: string, recent: IslandStep[],
 *   detail?: string, action?: string, startedAt?: number, steps?: number, elapsedMs?: number,
 *   permission?: { requestId: string, title: string, kind: string, options: { optionId: string, name: string, allow: boolean }[] },
 *   question?: { questionId: string, id: string, text: string, options: string[] },
 * }} IslandView
 */

const recentSteps = (state) => traceItems(state).slice(-RECENT_STEPS).map(({ title, tone }) => ({ title, tone }))

/** The first line of an answer as plain text: what the island shows of it once the turn is done. */
export function answerPreview(text) {
  const line = String(text ?? '').split('\n').map((item) => item.trim()).find(Boolean) ?? ''
  const plain = line
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
    .replace(/[*_`~]/g, '')
    .trim()
  return truncate(plain, PREVIEW_LIMIT)
}

function permissionView(permission) {
  return {
    requestId: permission.requestId,
    title: permission.title,
    kind: permission.kind,
    options: permission.options.map((option) => ({ optionId: option.optionId, name: optionName(option), allow: Boolean(option.kind?.startsWith('allow')) })),
  }
}

/** Only one question with one choice can be answered from the island; for anything else it opens the window. */
function questionView(question) {
  const [first] = question.questions
  const single = question.questions.length === 1 && !first.multiSelect
  return {
    questionId: question.questionId,
    id: first.id,
    text: first.question,
    options: single ? first.options.map((option) => option.label) : [],
  }
}

function lastAnswer(state) {
  const message = state.messages.findLast((item) => item.role === 'assistant')
  return message ? answerPreview(message.text) : ''
}

function afterTurn(state, base) {
  const receipt = state.lastReceipt
  if (receipt.stopReason === 'cancelled') return { ...base, form: 'idle', tone: 'idle', label: '已停止', detail: state.info.model || '' }
  return { ...base, form: 'done', tone: 'done', label: '已完成', elapsedMs: receipt.ms, detail: lastAnswer(state) }
}

/**
 * @param {object} state the renderer state (state.js)
 * @returns {IslandView}
 */
export function islandView(state) {
  const base = { mood: catMood(state), recent: recentSteps(state) }
  if (state.phase === 'waiting' && state.permission) {
    return { ...base, form: 'waiting', tone: 'waiting', label: '等待你确认', permission: permissionView(state.permission) }
  }
  if (state.phase === 'asking' && state.secret) {
    const { requestId, server } = state.secret
    return { ...base, form: 'asking', tone: 'waiting', label: '等你填写', question: { questionId: requestId, id: 'secret', text: `接入「${server}」需要你填写密钥`, options: [] } }
  }
  if (state.phase === 'asking' && state.question) {
    return { ...base, form: 'asking', tone: 'waiting', label: '等你回答', question: questionView(state.question) }
  }
  if (state.phase === 'working') {
    return {
      ...base, form: 'working', tone: 'working', label: '工作中',
      action: currentAction(state), startedAt: state.turn?.startedAt ?? null, steps: state.turn?.tools ?? 0,
    }
  }
  if (state.phase === 'error') return { ...base, form: 'error', tone: 'error', label: '出错', detail: truncate(state.error, DETAIL_LIMIT) }
  if (state.info.mode === 'connecting') return { ...base, form: 'pending', tone: 'pending', label: '连接中' }
  if (state.info.mode === 'setup') return { ...base, form: 'pending', tone: 'pending', label: '未连接' }
  if (state.lastReceipt) return afterTurn(state, base)
  return { ...base, form: 'idle', tone: 'idle', label: '空闲', detail: state.info.model || '' }
}
