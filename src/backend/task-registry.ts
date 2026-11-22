import { t } from '../shared/i18n/translate.ts'
import path from 'node:path'
import type { ActiveTool } from '../shared/ipc-results.ts'

import type { TaskStatus, TaskSnapshot } from '../shared/ipc-results.ts'
export type { TaskStatus, TaskSnapshot } from '../shared/ipc-results.ts'
interface Task extends TaskSnapshot { cwd: string, request: string, resultKey?: string, previewTruncated: boolean, resultFromTerminal: boolean }
export interface TaskMetadata { id: string, runId?: string, title: string, cwd?: string, words?: string, startedAt?: number, endedAt?: number, status?: string, resultPreview?: string, resultKey?: string, resultTruncated?: boolean, resultFromTerminal?: boolean }
export type TaskScope = { kind: 'main', cwd?: string } | { taskId: string }
export type TaskQuery = { op: 'list' | 'get', taskId?: string, status?: TaskStatus, cwd?: string, limit?: number, offset?: number, includeRequest?: boolean, includeOutput?: boolean, outputOffset?: number, outputLimit?: number }
export const DEFAULT_OUTPUT_LIMIT = 4000
export const MAX_OUTPUT_LIMIT = 4000
const MAX_TERMINAL_MESSAGE_CHARS = 200_000
const statuses = new Set<string>(['running', 'waiting', 'done', 'stopped', 'error', 'interrupted'])
const terminal = new Set<TaskStatus>(['done', 'stopped', 'error', 'interrupted'])
/** How a task's turn ended (acp-bridge task_end's stopReason), as its status. */
export const endedStatus = (stopReason: unknown): TaskStatus => stopReason === 'cancelled' ? 'stopped' : stopReason === 'error' ? 'error' : 'done'
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const text = (value: unknown) => typeof value === 'string' ? value : ''
const copy = <K, V>(map: Map<K, V> | undefined): Map<K, V> | undefined => map ? new Map(map) : undefined
const directory = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)

/** Main-process projection: no renderer round trip and no disk read on a tool query unless full output is requested. */
export function createTaskRegistry({ now = Date.now, changed = (_snapshot: TaskSnapshot) => {}, readOutput }: {
  now?: () => number
  changed?: (snapshot: TaskSnapshot) => void
  readOutput?: (taskId: string) => string | null | undefined
} = {}) {
  const tasks = new Map<string, Task>()
  const waits = new Map<string, Map<string, 'permission' | 'answer'>>()
  const tools = new Map<string, Map<string, string>>()
  const streams = new Map<string, { key: string, blocks: Map<number, string> }>()
  const terminalMessages = new Map<string, string>()
  const published = new Map<string, string>()
  const snapshot = ({ cwd: _cwd, request: _request, resultKey: _resultKey, previewTruncated: _previewTruncated, resultFromTerminal: _resultFromTerminal, ...value }: Task): TaskSnapshot => ({ ...value })
  function publish(task: Task) {
    task.updatedAt = now(); task.revision++
    // Text chunks already have their own UI event. Do not double renderer work on every token.
    const signature = JSON.stringify([task.status, task.currentAction, task.waitingFor, task.startedAt, task.endedAt])
    if (published.get(task.taskId) === signature) return
    published.set(task.taskId, signature)
    changed(snapshot(task))
  }
  function put(meta: TaskMetadata, restored = false) {
    const previous = tasks.get(meta.id)
    if (previous && !restored) return
    const status: TaskStatus = restored ? (Number.isFinite(meta.endedAt) && ['done', 'stopped', 'error'].includes(meta.status ?? '') ? meta.status as TaskStatus : 'interrupted') : 'running'
    const rawPreview = meta.resultPreview ?? ''
    const task: Task = { taskId: meta.id, runId: meta.runId ?? '', title: meta.title.slice(0, 200), cwd: meta.cwd ?? '', request: (meta.words ?? '').slice(0, 20_000),
      status, currentAction: null, waitingFor: null, startedAt: meta.startedAt ?? now(), updatedAt: now(), endedAt: status === 'interrupted' ? null : meta.endedAt ?? null,
      resultPreview: rawPreview.slice(-4000), resultKey: meta.resultKey, previewTruncated: Boolean(meta.resultTruncated) || rawPreview.length > 4000,
      resultFromTerminal: Boolean(meta.resultFromTerminal), revision: 0 }
    terminalMessages.delete(meta.id)
    tasks.set(meta.id, task)
    publish(task)
  }
  function restart(id: string, runId = '') {
    const task = tasks.get(id); if (!task) return
    waits.delete(id); tools.delete(id); streams.delete(id); terminalMessages.delete(id)
    Object.assign(task, { runId, status: 'running', waitingFor: null, currentAction: null, endedAt: null, resultPreview: '', resultKey: undefined, previewTruncated: false, resultFromTerminal: false, startedAt: now() })
    publish(task)
  }
  /** How a task is now in every map, to be put back if the change it was part of is undone. */
  function checkpoint(id: string): () => void {
    const task = tasks.get(id)
    const saved = { task: task ? { ...task } : undefined, waits: copy(waits.get(id)), tools: copy(tools.get(id)), published: published.get(id),
      terminalMessage: terminalMessages.get(id),
      stream: (() => { const stream = streams.get(id); return stream ? { key: stream.key, blocks: new Map(stream.blocks) } : undefined })() }
    const put = <V>(map: Map<string, V>, value: V | undefined) => { if (value === undefined) map.delete(id); else map.set(id, value) }
    return () => {
      put(tasks, saved.task ? { ...saved.task } : undefined)
      put(waits, copy(saved.waits)); put(tools, copy(saved.tools)); put(published, saved.published)
      put(terminalMessages, saved.terminalMessage)
      put(streams, saved.stream ? { key: saved.stream.key, blocks: new Map(saved.stream.blocks) } : undefined)
    }
  }
  function remove(id: string) { tasks.delete(id); waits.delete(id); tools.delete(id); streams.delete(id); terminalMessages.delete(id); published.delete(id) }
  function receive(raw: unknown) {
    const event = record(raw), id = text(event.taskId)
    if (!id) return
    const type = text(event.type)
    if (!['task_update', 'task_end', 'permission', 'task_permission_closed', 'task_question', 'task_question_closed'].includes(type)) return
    // A task is known before its run says anything (task-runtime.ts): what comes of one unknown, or no longer at work, is no task's.
    const task = tasks.get(id)
    if (!task || terminal.has(task.status)) return
    const pending = waits.get(id) ?? new Map<string, 'permission' | 'answer'>()
    waits.set(id, pending)
    if (type === 'permission') pending.set(`p:${text(event.requestId)}`, 'permission')
    if (type === 'task_permission_closed') pending.delete(`p:${text(event.requestId)}`)
    if (type === 'task_question') pending.set(`q:${text(event.questionId)}`, 'answer')
    if (type === 'task_question_closed') pending.delete(`q:${text(event.questionId)}`)
    if (type === 'task_update') {
      const update = record(event.update)
      const kind = text(update.sessionUpdate)
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        const active = tools.get(id) ?? new Map<string, string>(); tools.set(id, active)
        const toolId = text(update.toolCallId)
        if (update.status === 'completed' || update.status === 'failed') active.delete(toolId)
        else if (toolId) active.set(toolId, text(update.title).slice(0, 200) || active.get(toolId) || t("main.task-registry.run.tool"))
        task.currentAction = [...active.values()].at(-1) ?? null
      }
      if (kind === 'agent_message_chunk') {
        task.resultKey = undefined
        task.resultFromTerminal = false
        const next = task.resultPreview + text(record(update.content).text)
        if (next.length > 4000) task.previewTruncated = true
        task.resultPreview = next.slice(-4000)
      }
      if (kind === 'viva_stream') {
        const key = text(update.key)
        let stream = streams.get(id)
        if (!stream || stream.key !== key) { stream = { key, blocks: new Map() }; streams.set(id, stream) }
        if (update.kind === 'settle' && Array.isArray(update.blocks)) {
          task.resultKey = key || undefined
          task.resultFromTerminal = false
          const next = update.blocks.map(record).filter(block => block.type === 'text').map(block => text(block.text)).join('\n')
          task.previewTruncated = next.length > 4000
          task.resultPreview = next.slice(-4000)
        } else if (update.blockType === 'text' && typeof update.index === 'number') {
          task.resultKey = key || undefined
          task.resultFromTerminal = false
          const old = stream.blocks.get(update.index) ?? ''
          const nextBlock = update.kind === 'delta' ? old + text(update.text) : text(update.text)
          if (nextBlock.length > 4000) task.previewTruncated = true
          stream.blocks.set(update.index, nextBlock.slice(-4000))
          // Bound memory even for a long response with many text blocks.
          while (stream.blocks.size > 16) {
            stream.blocks.delete(stream.blocks.keys().next().value!)
            task.previewTruncated = true
          }
          const joined = [...stream.blocks.values()].join('\n')
          if (joined.length > 4000) task.previewTruncated = true
          task.resultPreview = joined.slice(-4000)
        }
      }
    }
    task.waitingFor = [...pending.values()].includes('permission') ? 'permission' : [...pending.values()][0] ?? null
    task.status = task.waitingFor ? 'waiting' : 'running'
    if (type === 'task_end') {
      task.status = endedStatus(event.stopReason)
      task.endedAt = now(); task.waitingFor = null; task.currentAction = null
      if (event.message) {
        const fullMessage = text(event.message)
        task.resultKey = undefined
        task.resultFromTerminal = true
        task.previewTruncated = fullMessage.length > 4000
        task.resultPreview = fullMessage.slice(-4000)
        if (fullMessage.length <= MAX_TERMINAL_MESSAGE_CHARS) terminalMessages.set(id, fullMessage)
        else terminalMessages.delete(id)
      }
      waits.delete(id); tools.delete(id); streams.delete(id)
    }
    publish(task)
  }
  /** dsh went: the tasks at work are interrupted, but for those whose end came already and is still being kept. */
  function interrupt(ending: ReadonlySet<string> = new Set()) {
    for (const task of tasks.values()) if (!terminal.has(task.status) && !ending.has(task.taskId)) {
      task.status = 'interrupted'; task.currentAction = null; task.waitingFor = null; publish(task)
    }
    waits.clear(); tools.clear(); streams.clear()
  }
  function query(request: TaskQuery, scope: TaskScope) {
    const visible = (task: Task) => 'taskId' in scope ? task.taskId === scope.taskId : true
    const dir = request.cwd ? directory(request.cwd) : null
    if (request.op === 'get') {
      const task = tasks.get(request.taskId ?? '')
      if (!task || !visible(task)) throw new Error(t("main.task-registry.task.does.not.exist.or.is.outside"))
      let outputFields: {
        resultPreview: string | undefined
        outputOffset?: number
        outputTotalChars?: number | null
        nextOutputOffset?: number | null
        outputTruncated?: boolean
      } = { resultPreview: undefined }
      if (request.includeOutput) {
        const resolved = task.resultFromTerminal
          ? (terminalMessages.get(task.taskId) ?? null)
          : readOutput?.(task.taskId)
        const full = resolved ?? task.resultPreview
        const previewOnlyTruncated = resolved == null && task.previewTruncated
        const total = full.length
        const start = Math.min(request.outputOffset ?? 0, total)
        const limit = Math.min(request.outputLimit ?? DEFAULT_OUTPUT_LIMIT, MAX_OUTPUT_LIMIT)
        const slice = full.slice(start, start + limit)
        const nextOutputOffset = start + slice.length < total ? start + slice.length : null
        outputFields = {
          resultPreview: slice,
          outputOffset: start,
          outputTotalChars: previewOnlyTruncated ? null : total,
          nextOutputOffset,
          outputTruncated: previewOnlyTruncated || start > 0 || nextOutputOffset !== null,
        }
      }
      return { observedAt: now(), task: { ...snapshot(task), ...(task.cwd ? { cwd: task.cwd } : {}), ...outputFields,
        ...(request.includeRequest ? { request: task.request } : {}) } }
    }
    const list = [...tasks.values()].filter(task => visible(task)
      && (!request.status || task.status === request.status)
      && (!dir || (Boolean(task.cwd) && directory(task.cwd) === dir)))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId))
    const offset = request.offset ?? 0, limit = request.limit ?? 10
    return { observedAt: now(), total: list.length, nextOffset: offset + limit < list.length ? offset + limit : null,
      tasks: list.slice(offset, offset + limit).map(task => ({ ...snapshot(task), ...(task.cwd ? { cwd: task.cwd } : {}), resultPreview: undefined })) }
  }
  /** The run a task is at, while it works or waits on the user; null for one unknown or no longer at work. */
  const runOf = (id: string): string | null => {
    const task = tasks.get(id)
    return task && !terminal.has(task.status) ? task.runId : null
  }
  /** How a task stands now, as its snapshots say it, or null for one unknown. */
  const snapshotOf = (id: string): TaskSnapshot | null => {
    const task = tasks.get(id)
    return task ? snapshot(task) : null
  }
  /** How many times a task has changed (its snapshots' `revision`), or null for one unknown. */
  const revisionOf = (id: string): number | null => tasks.get(id)?.revision ?? null
  const resultKeyOf = (id: string) => tasks.get(id)?.resultKey
  const resultTruncatedOf = (id: string) => Boolean(tasks.get(id)?.previewTruncated)
  const resultFromTerminalOf = (id: string) => Boolean(tasks.get(id)?.resultFromTerminal)
  /** The tool calls a task's run has at work now, in the order they began: for a window that opens (task-runtime.ts finished). */
  const activeTools = (id: string): ActiveTool[] => [...(tools.get(id) ?? new Map<string, string>())].map(([toolCallId, title]) => ({ toolCallId, title }))
  /** Tasks at work or waiting on the user, this launch. */
  const live = () => [...tasks.values()].filter((task) => task.status === 'running' || task.status === 'waiting').length
  return { put, restart, remove, resultKeyOf, resultTruncatedOf, resultFromTerminalOf, receive, interrupt, query, live, runOf, revisionOf, snapshotOf, activeTools, checkpoint }
}
export type TaskRegistry = ReturnType<typeof createTaskRegistry>

export function parseTaskQuery(value: unknown): TaskQuery {
  const raw = record(value)
  if (raw.op !== 'list' && raw.op !== 'get') throw new Error(t("main.task-registry.unknown.task.query.operation"))
  if (raw.op === 'get' && (typeof raw.taskId !== 'string' || !raw.taskId || raw.taskId.length > 200)) throw new Error(t("main.task-registry.invalid.taskid"))
  if (raw.status !== undefined && !statuses.has(text(raw.status))) throw new Error(t("main.task-registry.invalid.status"))
  if (raw.cwd !== undefined && (typeof raw.cwd !== 'string' || !raw.cwd.trim() || raw.cwd.length > 4096)) throw new Error(t("main.task-registry.invalid", { key: 'cwd' }))
  for (const key of ['limit', 'offset'] as const) if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < (key === 'limit' ? 1 : 0))) throw new Error(t("main.task-registry.invalid", { key: key }))
  for (const key of ['outputLimit', 'outputOffset'] as const) if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < (key === 'outputLimit' ? 1 : 0))) throw new Error(t("main.task-registry.invalid", { key: key }))
  for (const key of ['includeRequest', 'includeOutput'] as const) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw new Error(t("main.task-registry.invalid", { key: key }))
  return { op: raw.op, taskId: text(raw.taskId), status: raw.status as TaskStatus | undefined, ...(raw.cwd !== undefined ? { cwd: raw.cwd.trim() } : {}),
    limit: Math.min(Number(raw.limit ?? 10), 30), offset: Number(raw.offset ?? 0), includeRequest: raw.includeRequest === true, includeOutput: raw.includeOutput === true,
    ...(raw.outputOffset !== undefined ? { outputOffset: Number(raw.outputOffset) } : {}),
    ...(raw.outputLimit !== undefined ? { outputLimit: Math.min(Number(raw.outputLimit), MAX_OUTPUT_LIMIT) } : {}) }
}
