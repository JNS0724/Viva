import type { ScheduleRuleView } from './proposal-types.ts'
import { objectOf } from '../shared/unknown-value.ts'
import { contextOf } from '../shared/conversation-context.ts'
import type { WindowSnapshot, TaskOpening, TaskSummary } from '../shared/ipc-results.ts'
import type { ConversationUpdate, ForegroundWaits, PermissionRequest, AskedSecret, MemoryInjection } from './conversation-types.ts'
import type { AgentEvent } from './agent-event-types.ts'

type ObjectValue = Record<string, unknown>
const string = (value: unknown): value is string => typeof value === 'string'
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const natural = (value: unknown): value is number => number(value) && Number.isSafeInteger(value) && value >= 0
const nullableText = (value: unknown): value is string | null => value === null || string(value)
const optional = <T>(value: unknown, test: (value: unknown) => value is T): value is T | undefined => value === undefined || test(value)
function list<T>(value: unknown, read: (value: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null
  const result: T[] = []
  for (const item of value) { const parsed = read(item); if (parsed === null) return null; result.push(parsed) }
  return result
}
const texts = (value: unknown) => list(value, item => string(item) ? item : null)
const choice = (value: unknown) => { const item = objectOf(value); return item && string(item.value) && string(item.name) && optional(item.group, string) ? { value: item.value, name: item.name, ...(item.group === undefined ? {} : { group: item.group }) } : null }
export function decodeInfo(value: unknown): AgentInfo | null {
  const item = objectOf(value)
  if (!item || !string(item.mode) || !string(item.model) || !string(item.cwd)) return null
  if (!optional(item.sessionId, nullableText) || !optional(item.conversationId, string) || !optional(item.reason, string)
    || !optional(item.problem, string) || !optional(item.modelValue, string) || !optional(item.effort, string)
    || !optional(item.remembersHistory, (value): value is boolean => typeof value === 'boolean')) return null
  const models = item.models === undefined ? undefined : list(item.models, choice)
  const efforts = item.efforts === undefined ? undefined : list(item.efforts, choice)
  if (models === null || efforts === null) return null
  const mcp = objectOf(item.mcp)
  const dropped = mcp?.dropped === undefined ? [] : list(mcp.dropped, value => { const row = objectOf(value); return row && string(row.name) && string(row.reason) ? { name: row.name, reason: row.reason } : null })
  const active = mcp?.active === undefined ? [] : texts(mcp.active)
  if (item.mcp !== undefined && (!mcp || !active || !dropped)) return null
  return { mode: item.mode, model: item.model, cwd: item.cwd,
    ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
    ...(item.conversationId === undefined ? {} : { conversationId: item.conversationId }),
    ...(item.reason === undefined ? {} : { reason: item.reason }),
    ...(item.problem === undefined ? {} : { problem: item.problem }),
    ...(item.modelValue === undefined ? {} : { modelValue: item.modelValue }),
    ...(item.effort === undefined ? {} : { effort: item.effort }),
    ...(item.remembersHistory === undefined ? {} : { remembersHistory: item.remembersHistory }),
    ...(models ? { models } : {}), ...(efforts ? { efforts } : {}), ...(mcp && active && dropped ? { mcp: { active, dropped } } : {}) }

}
export function decodeQuestions(value: unknown): QuestionItem[] | null {
  return list(value, value => {
    const item = objectOf(value)
    if (!item || !string(item.id) || !string(item.question) || !optional(item.header, string) || !optional(item.multiSelect, (value): value is boolean => typeof value === 'boolean')) return null
    const options = list(item.options, value => { const row = objectOf(value); return row && string(row.label) && optional(row.description, string) ? { label: row.label, description: row.description } : null })
    return options ? { id: item.id, question: item.question, header: item.header, multiSelect: item.multiSelect, options } : null
  })
}
export function decodePermission(value: unknown): PermissionRequest | null {
  const item = objectOf(value), tool = objectOf(item?.toolCall)
  if (!item || !string(item.requestId) || !tool || !optional(tool.toolCallId, string) || !optional(tool.title, nullableText) || !optional(tool.kind, nullableText)) return null
  const options = list(item.options, value => { const row = objectOf(value); return row && string(row.optionId) && string(row.name) && optional(row.kind, string) ? { optionId: row.optionId, name: row.name, kind: row.kind } : null })
  return options ? { requestId: item.requestId, toolCall: { toolCallId: tool.toolCallId, title: tool.title, kind: tool.kind, rawInput: tool.rawInput }, options } : null
}
const secret = (value: unknown): AskedSecret | null => {
  const item = objectOf(value), names = texts(item?.names)
  return item && string(item.requestId) && string(item.server) && names ? { requestId: item.requestId, server: item.server, names } : null
}
export function decodeWaits(value: unknown): ForegroundWaits | null {
  const item = objectOf(value)
  if (!item) return null
  const permissions = list(item.permissions ?? [], decodePermission)
  const questions = list(item.questions ?? [], value => { const row = objectOf(value), questions = decodeQuestions(row?.questions); return row && string(row.questionId) && questions ? { questionId: row.questionId, questions } : null })
  const secrets = list(item.secrets ?? [], secret)
  return permissions && questions && secrets ? { permissions, questions, secrets } : null
}
const ignoredUpdates = ['user_message_chunk', 'plan', 'plan_update', 'plan_removed', 'available_commands_update', 'current_mode_update', 'config_option_update', 'session_info_update', 'notice', 'compaction_update', 'compaction_summary_chunk', 'subagent_update', 'session_message', 'session_message_chunk'] as const
export function decodeUpdate(value: unknown): ConversationUpdate | null {
  const item = objectOf(value)
  if (!item) return null
  if (item.sessionUpdate === 'agent_message_chunk' || item.sessionUpdate === 'agent_thought_chunk') {
    const content = objectOf(item.content)
    if (content?.type === 'text') return string(content.text) ? { sessionUpdate: item.sessionUpdate, content: { type: 'text', text: content.text } } : null
    if (!content || !['image', 'audio', 'resource_link', 'resource'].includes(String(content.type))) return null
    return { sessionUpdate: item.sessionUpdate, content: { type: content.type as 'image' | 'audio' | 'resource_link' | 'resource' } }

  }
  if (item.sessionUpdate === 'tool_call' || item.sessionUpdate === 'tool_call_update') {
    if (!string(item.toolCallId) || !optional(item.title, nullableText) || !optional(item.kind, nullableText) || !optional(item.status, nullableText)) return null
    const locations = item.locations === undefined || item.locations === null ? item.locations : list(item.locations, value => { const row = objectOf(value); return row && string(row.path) && optional(row.line, (v): v is number | null => v === null || natural(v)) ? { path: row.path, line: row.line } : null })
    if (item.locations !== null && locations === null) return null
    return { sessionUpdate: item.sessionUpdate, toolCallId: item.toolCallId, title: item.title, kind: item.kind, status: item.status, rawInput: item.rawInput, locations }
  }
  if (item.sessionUpdate === 'usage_update') return number(item.used) && number(item.size) ? { sessionUpdate: item.sessionUpdate, used: item.used, size: item.size } : null
  if (item.sessionUpdate === 'viva_stream') {
    if (!string(item.key)) return null
    if (item.kind === 'settle') {
      const blocks = list(item.blocks, value => { const block = objectOf(value); return block && string(block.type) && optional(block.text, string) ? { type: block.type, text: block.text } : null })
      return blocks ? { sessionUpdate: item.sessionUpdate, key: item.key, kind: 'settle', blocks } : null
    }
    if ((item.kind === 'delta' || item.kind === 'block') && natural(item.index) && (item.blockType === 'text' || item.blockType === 'reasoning') && string(item.text)) return { sessionUpdate: item.sessionUpdate, key: item.key, kind: item.kind, index: item.index, blockType: item.blockType, text: item.text }
    return null
  }
  const ignored = ignoredUpdates.find(tag => tag === item.sessionUpdate)
  return ignored ? { sessionUpdate: ignored } : null
}
function summary(value: unknown): TaskSummary | null {
  const item = objectOf(value)
  if (!item || !string(item.id) || !string(item.segmentId) || !string(item.title) || !string(item.words)) return null
  const host = objectOf(item.host)
  if (item.host !== undefined && (!host || !string(host.conversationId) || !number(host.at) || !natural(host.order))) return null
  return { id: item.id, segmentId: item.segmentId, title: item.title, words: item.words, ...(host ? { host: { conversationId: host.conversationId as string, at: host.at as number, order: host.order as number } } : {}) }
}
function snapshot(value: unknown): WindowSnapshot | null {
  const item = objectOf(value)
  if (!item || !string(item.taskId) || !string(item.runId) || !string(item.title) || !number(item.startedAt) || !number(item.updatedAt) || !(item.endedAt === null || number(item.endedAt)) || !natural(item.revision) || !natural(item.taskSeq) || !nullableText(item.currentAction) || !string(item.resultPreview)) return null
  if (item.status !== 'running' && item.status !== 'waiting' && item.status !== 'done' && item.status !== 'stopped' && item.status !== 'error' && item.status !== 'interrupted') return null
  if (item.waitingFor !== null && item.waitingFor !== 'permission' && item.waitingFor !== 'answer') return null
  let opening: TaskOpening | undefined
  if (item.opening !== undefined) {
    const row = objectOf(item.opening), task = row?.task === undefined ? undefined : summary(row.task)
    if (!row || !string(row.words) || !optional(row.hostSession, nullableText) || task === null) return null
    opening = { words: row.words, hostSession: row.hostSession, task }
  }
  return { taskId: item.taskId, runId: item.runId, title: item.title, startedAt: item.startedAt, updatedAt: item.updatedAt, endedAt: item.endedAt,
    revision: item.revision, taskSeq: item.taskSeq, currentAction: item.currentAction, resultPreview: item.resultPreview, status: item.status, waitingFor: item.waitingFor, opening }
}
const memoryInjection = (value: unknown): MemoryInjection | null => {
  const item = objectOf(value)
  if (!item || !number(item.at) || !optional(item.fixed, nullableText)) return null
  const pushed = item.pushed === undefined ? [] : list(item.pushed, value => { const row = objectOf(value), names = texts(row?.names); return row && names && string(row.text) ? { names, text: row.text } : null })
  return pushed ? { at: item.at, fixed: item.fixed, pushed } : null
}
function scheduleRule(value: unknown): ScheduleRuleView | null {
  const rule = objectOf(value)
  if (rule?.kind === 'at') return { kind: 'at' }
  if (rule?.kind === 'daily') { const daily = objectOf(rule.daily); return daily && string(daily.time) ? { kind: 'daily', daily: { time: daily.time } } : null }
  if (rule?.kind === 'weekly') {
    const weekly = objectOf(rule.weekly), weekdays = list(weekly?.weekdays, value => natural(value) && value <= 7 ? value : null)
    return weekly && string(weekly.time) && weekdays ? { kind: 'weekly', weekly: { time: weekly.time, weekdays } } : null
  }
  if (rule?.kind === 'cron') { const cron = objectOf(rule.cron); return cron && string(cron.expression) ? { kind: 'cron', cron: { expression: cron.expression } } : null }
  return null
}
function eventOf(item: ObjectValue): AgentEvent | null {
  const context = contextOf(item), type = item.type
  if (type === 'ready' || type === 'workdir' || type === 'config') {
    const info = decodeInfo(item.info)
    if (!info || (item.context !== undefined && !context)) return null
    return type === 'config' ? { type, info, ...(context ? { context } : {}) } : { type, info }
  }
  if (type === 'error') return string(item.message) && (item.context === undefined || context) ? { type, message: item.message, ...(context ? { context } : {}) } : null
  if (type === 'memory_changed') {
    const memories = item.memories === undefined ? undefined : texts(item.memories), invalidated = item.invalidated === undefined ? undefined : texts(item.invalidated)
    return memories !== null && invalidated !== null ? { type, memories, invalidated } : null
  }
  if (type === 'files_changed') return string(item.path) ? { type, path: item.path } : null
  if (type === 'feed_changed' || type === 'schedules_changed') return { type }
  if (type === 'task_snapshot') { const parsed = snapshot(item.snapshot); return parsed ? { type, snapshot: parsed } : null }
  const task = string(item.taskId) && string(item.runId) && natural(item.taskSeq) ? { taskId: item.taskId, runId: item.runId, taskSeq: item.taskSeq } : null
  if (type === 'permission') {
    const parsed = decodePermission(item)
    if (!parsed) return null
    return item.taskId === undefined ? (context ? { type, ...parsed, context } : null) : (task ? { type, ...parsed, ...task } : null)
  }
  if (type === 'task_update') { const update = decodeUpdate(item.update); return task && update ? { type, ...task, update } : null }
  if (type === 'task_permission_closed') return task && string(item.requestId) ? { type, ...task, requestId: item.requestId } : null
  if (type === 'task_question') { const questions = decodeQuestions(item.questions); return task && string(item.questionId) && questions ? { type, ...task, questionId: item.questionId, questions } : null }
  if (type === 'task_question_closed') return task && string(item.questionId) ? { type, ...task, questionId: item.questionId } : null
  if (type === 'task_steered') return task && string(item.text) ? { type, ...task, text: item.text } : null
  if (type === 'task_end') return task && optional(item.stopReason, string) && optional(item.message, nullableText) ? { type, ...task, stopReason: item.stopReason, message: item.message } : null
  // Every remaining foreground payload must prove its original history segment and runtime session.
  if (!context || item.taskId !== undefined) return null
  if (type === 'update') { const update = decodeUpdate(item.update); return update ? { type, context, update } : null }
  if (type === 'turn_started') return optional(item.by, nullableText) ? { type, context, by: item.by } : null
  if (type === 'turn_end') return optional(item.stopReason, string) ? { type, context, stopReason: item.stopReason } : null
  if (type === 'question') { const questions = decodeQuestions(item.questions); return string(item.questionId) && questions ? { type, context, questionId: item.questionId, questions } : null }
  if (type === 'question_closed') return string(item.questionId) ? { type, context, questionId: item.questionId } : null
  if (type === 'secret_request') { const parsed = secret(item); return parsed ? { type, context, ...parsed } : null }
  if (type === 'secret_closed') return string(item.requestId) ? { type, context, requestId: item.requestId } : null
  if (type === 'waits') { const parsed = decodeWaits(item); return parsed ? { type, context, ...parsed } : null }
  if (type === 'memory_context') { const injected = list(item.injected, memoryInjection); return injected ? { type, context, injected } : null }
  if (type === 'report_delivered') return nullableText(item.conversationId) && nullableText(item.sessionId) && string(item.reportId) && string(item.text) && number(item.at) ? { type, context, conversationId: item.conversationId, sessionId: item.sessionId, reportId: item.reportId, text: item.text, at: item.at } : null
  if (type === 'schedule_propose') {
    const proposal = objectOf(item.proposal), rule = scheduleRule(proposal?.rule)
    return proposal && rule && string(proposal.proposalId) && string(proposal.title) && string(proposal.prompt) && string(proposal.firstAt) ? { type, context, proposal: { proposalId: proposal.proposalId, title: proposal.title, prompt: proposal.prompt, firstAt: proposal.firstAt, rule } } : null
  }
  return null
}
export const EVENT_TAGS = {
  ready: true, workdir: true, config: true, update: true, turn_started: true, turn_end: true, permission: true, question: true, question_closed: true, secret_request: true, secret_closed: true, waits: true, memory_context: true, report_delivered: true, error: true, schedule_propose: true, memory_changed: true, files_changed: true, feed_changed: true, schedules_changed: true, task_snapshot: true, task_update: true, task_permission_closed: true, task_question: true, task_question_closed: true, task_steered: true, task_end: true
} satisfies Record<AgentEvent['type'], true>

export interface EventIssue { reason: 'unknown-event' | 'malformed-event', tag: string }
/** Unknown input stops here. Diagnostics contain a known tag/reason only, never source payloads. */
export function decodeAgentEvent(value: unknown, rejected: (issue: EventIssue) => void = () => {}): AgentEvent | null {
  const item = objectOf(value), known = string(item?.type) && Object.hasOwn(EVENT_TAGS, item.type)
  const parsed = known && item ? eventOf(item) : null
  if (!parsed) rejected({ reason: known ? 'malformed-event' : 'unknown-event', tag: known ? item!.type as string : 'unrecognized' })
  return parsed
}
