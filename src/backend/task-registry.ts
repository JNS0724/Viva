import { t } from '../shared/i18n/translate.ts'
import path from 'node:path'
import type { ActiveTool } from '../shared/ipc-results.ts'

import type { TaskStatus, TaskSnapshot } from '../shared/ipc-results.ts'
export type { TaskStatus, TaskSnapshot } from '../shared/ipc-results.ts'
interface Task extends TaskSnapshot { cwd: string, request: string }
export interface TaskMetadata { id: string, runId?: string, title: string, cwd?: string, words?: string, startedAt?: number, endedAt?: number, status?: string, resultPreview?: string }
export type TaskScope = { cwd: string } | { taskId: string }
export type TaskQuery = { op: 'list' | 'get', taskId?: string, status?: TaskStatus, limit?: number, offset?: number, includeRequest?: boolean, includeOutput?: boolean }
const statuses = new Set<string>(['running', 'waiting', 'done', 'stopped', 'error', 'interrupted'])
const terminal = new Set<TaskStatus>(['done', 'stopped', 'error', 'interrupted'])
/** How a task's turn ended (acp-bridge task_end's stopReason), as its status. */
export const endedStatus = (stopReason: unknown): TaskStatus => stopReason === 'cancelled' ? 'stopped' : stopReason === 'error' ? 'error' : 'done'
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const text = (value: unknown) => typeof value === 'string' ? value : ''
const copy = <K, V>(map: Map<K, V> | undefined): Map<K, V> | undefined => map ? new Map(map) : undefined
const directory = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)

/** Main-process projection: no renderer round trip and no disk read on a tool query. */
export function createTaskRegistry({ now = Date.now, changed = (_snapshot: TaskSnapshot) => {} } = {}) {
  const tasks = new Map<string, Task>()
  const waits = new Map<string, Map<string, 'permission' | 'answer'>>()
  const tools = new Map<string, Map<string, string>>()
  const streams = new Map<string, { key: string, blocks: Map<number, string> }>()
  const published = new Map<string, string>()
  const snapshot = ({ cwd: _cwd, request: _request, ...value }: Task): TaskSnapshot => ({ ...value })
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
    const task: Task = { taskId: meta.id, runId: meta.runId ?? '', title: meta.title.slice(0, 200), cwd: meta.cwd ?? '', request: (meta.words ?? '').slice(0, 20_000),
      status, currentAction: null, waitingFor: null, startedAt: meta.startedAt ?? now(), updatedAt: now(), endedAt: status === 'interrupted' ? null : meta.endedAt ?? null,
      resultPreview: (meta.resultPreview ?? '').slice(-4000), revision: 0 }
    tasks.set(meta.id, task)
    publish(task)
  }
  function restart(id: string, runId = '') {
    const task = tasks.get(id); if (!task) return
    waits.delete(id); tools.delete(id); streams.delete(id)
    Object.assign(task, { runId, status: 'running', waitingFor: null, currentAction: null, endedAt: null, resultPreview: '', startedAt: now() })
    publish(task)
  }
  /** How a task is now in every map, to be put back if the change it was part of is undone. */
  function checkpoint(id: string): () => void {
    const task = tasks.get(id)
    const saved = { task: task ? { ...task } : undefined, waits: copy(waits.get(id)), tools: copy(tools.get(id)), published: published.get(id),
      stream: (() => { const stream = streams.get(id); return stream ? { key: stream.key, blocks: new Map(stream.blocks) } : undefined })() }
    const put = <V>(map: Map<string, V>, value: V | undefined) => { if (value === undefined) map.delete(id); else map.set(id, value) }
    return () => {
      put(tasks, saved.task ? { ...saved.task } : undefined)
      put(waits, copy(saved.waits)); put(tools, copy(saved.tools)); put(published, saved.published)
      put(streams, saved.stream ? { key: saved.stream.key, blocks: new Map(saved.stream.blocks) } : undefined)
    }
  }
  function remove(id: string) { tasks.delete(id); waits.delete(id); tools.delete(id); streams.delete(id); published.delete(id) }
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
      if (kind === 'agent_message_chunk') task.resultPreview = (task.resultPreview + text(record(update.content).text)).slice(-4000)
      if (kind === 'viva_stream') {
        const key = text(update.key)
        let stream = streams.get(id)
        if (!stream || stream.key !== key) { stream = { key, blocks: new Map() }; streams.set(id, stream) }
        if (update.kind === 'settle' && Array.isArray(update.blocks)) {
          task.resultPreview = update.blocks.map(record).filter(block => block.type === 'text').map(block => text(block.text)).join('\n').slice(-4000)
        } else if (update.blockType === 'text' && typeof update.index === 'number') {
          const old = stream.blocks.get(update.index) ?? ''
          stream.blocks.set(update.index, (update.kind === 'delta' ? old + text(update.text) : text(update.text)).slice(-4000))
          // Bound memory even for a long response with many text blocks.
          while (stream.blocks.size > 16) stream.blocks.delete(stream.blocks.keys().next().value!)
          task.resultPreview = [...stream.blocks.values()].join('\n').slice(-4000)
        }
      }
    }
    task.waitingFor = [...pending.values()].includes('permission') ? 'permission' : [...pending.values()][0] ?? null
    task.status = task.waitingFor ? 'waiting' : 'running'
    if (type === 'task_end') {
      task.status = endedStatus(event.stopReason)
      task.endedAt = now(); task.waitingFor = null; task.currentAction = null
      if (event.message) task.resultPreview = text(event.message).slice(-4000)
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
    const visible = (task: Task) => 'taskId' in scope ? task.taskId === scope.taskId : Boolean(task.cwd && scope.cwd) && directory(task.cwd) === directory(scope.cwd)
    if (request.op === 'get') {
      const task = tasks.get(request.taskId ?? '')
      if (!task || !visible(task)) throw new Error(t("main.task-registry.task.does.not.exist.or.is.outside"))
      return { observedAt: now(), task: { ...snapshot(task), resultPreview: request.includeOutput ? task.resultPreview : undefined,
        ...(request.includeRequest ? { request: task.request } : {}) } }
    }
    const list = [...tasks.values()].filter(task => visible(task) && (!request.status || task.status === request.status))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId))
    const offset = request.offset ?? 0, limit = request.limit ?? 10
    return { observedAt: now(), total: list.length, nextOffset: offset + limit < list.length ? offset + limit : null,
      tasks: list.slice(offset, offset + limit).map(task => ({ ...snapshot(task), resultPreview: undefined })) }
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
  /** The tool calls a task's run has at work now, in the order they began: for a window that opens (task-runtime.ts finished). */
  const activeTools = (id: string): ActiveTool[] => [...(tools.get(id) ?? new Map<string, string>())].map(([toolCallId, title]) => ({ toolCallId, title }))
  /** Tasks at work or waiting on the user, this launch. */
  const live = () => [...tasks.values()].filter((task) => task.status === 'running' || task.status === 'waiting').length
  return { put, restart, remove, receive, interrupt, query, live, runOf, revisionOf, snapshotOf, activeTools, checkpoint }
}
export type TaskRegistry = ReturnType<typeof createTaskRegistry>

export function parseTaskQuery(value: unknown): TaskQuery {
  const raw = record(value)
  if (raw.op !== 'list' && raw.op !== 'get') throw new Error(t("main.task-registry.unknown.task.query.operation"))
  if (raw.op === 'get' && (typeof raw.taskId !== 'string' || !raw.taskId || raw.taskId.length > 200)) throw new Error(t("main.task-registry.invalid.taskid"))
  if (raw.status !== undefined && !statuses.has(text(raw.status))) throw new Error(t("main.task-registry.invalid.status"))
  for (const key of ['limit', 'offset'] as const) if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < (key === 'limit' ? 1 : 0))) throw new Error(t("main.task-registry.invalid", { key: key }))
  for (const key of ['includeRequest', 'includeOutput'] as const) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw new Error(t("main.task-registry.invalid", { key: key }))
  return { op: raw.op, taskId: text(raw.taskId), status: raw.status as TaskStatus | undefined, limit: Math.min(Number(raw.limit ?? 10), 30),
    offset: Number(raw.offset ?? 0), includeRequest: raw.includeRequest === true, includeOutput: raw.includeOutput === true }
}
