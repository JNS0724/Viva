import path from 'node:path'

export type TaskStatus = 'running' | 'waiting' | 'done' | 'stopped' | 'error' | 'interrupted'
export interface TaskSnapshot {
  taskId: string, title: string, status: TaskStatus, currentAction: string | null,
  waitingFor: 'permission' | 'answer' | null, startedAt: number, updatedAt: number,
  endedAt: number | null, resultPreview: string, revision: number,
}
interface Task extends TaskSnapshot { cwd: string, request: string }
export interface TaskMetadata { id: string, title: string, cwd?: string, words?: string, startedAt?: number, endedAt?: number, status?: string, resultPreview?: string }
export type TaskScope = { cwd: string } | { taskId: string }
export type TaskQuery = { op: 'list' | 'get', taskId?: string, status?: TaskStatus, limit?: number, offset?: number, includeRequest?: boolean, includeOutput?: boolean }
const statuses = new Set<string>(['running', 'waiting', 'done', 'stopped', 'error', 'interrupted'])
const terminal = new Set<TaskStatus>(['done', 'stopped', 'error', 'interrupted'])
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const text = (value: unknown) => typeof value === 'string' ? value : ''
const directory = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)

/** Main-process projection: no renderer round trip and no disk read on a tool query. */
export function createTaskRegistry({ now = Date.now, changed = (_snapshot: TaskSnapshot) => {} } = {}) {
  const tasks = new Map<string, Task>()
  const waits = new Map<string, Map<string, 'permission' | 'answer'>>()
  const tools = new Map<string, Map<string, string>>()
  const streams = new Map<string, { key: string, blocks: Map<number, string> }>()
  const published = new Map<string, string>()
  // Moving a live session to the background can emit its pending question before task IPC returns.
  const early = new Map<string, Record<string, unknown>[]>()
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
    const task: Task = { taskId: meta.id, title: meta.title.slice(0, 200), cwd: meta.cwd ?? '', request: (meta.words ?? '').slice(0, 20_000),
      status, currentAction: null, waitingFor: null, startedAt: meta.startedAt ?? now(), updatedAt: now(), endedAt: status === 'interrupted' ? null : meta.endedAt ?? null,
      resultPreview: (meta.resultPreview ?? '').slice(-4000), revision: 0 }
    tasks.set(meta.id, task)
    publish(task)
    const pending = early.get(meta.id) ?? []; early.delete(meta.id)
    for (const event of pending) receive(event)
  }
  function restart(id: string) {
    const task = tasks.get(id); if (!task) return
    waits.delete(id); tools.delete(id); streams.delete(id)
    Object.assign(task, { status: 'running', waitingFor: null, currentAction: null, endedAt: null, resultPreview: '', startedAt: now() })
    publish(task)
  }
  function remove(id: string) { tasks.delete(id); waits.delete(id); tools.delete(id); streams.delete(id); early.delete(id); published.delete(id) }
  function receive(raw: unknown) {
    const event = record(raw), id = text(event.taskId)
    if (!id) return
    const type = text(event.type)
    if (!['task_update', 'task_end', 'permission', 'task_permission_waiting', 'task_permission_closed', 'task_question', 'task_question_closed'].includes(type)) return
    const task = tasks.get(id)
    if (!task) {
      if (early.size >= 100 && !early.has(id)) early.delete(early.keys().next().value!)
      early.set(id, [...(early.get(id) ?? []).slice(-31), event]); return
    }
    if (terminal.has(task.status)) return
    const pending = waits.get(id) ?? new Map<string, 'permission' | 'answer'>()
    waits.set(id, pending)
    if (type === 'permission' || type === 'task_permission_waiting') pending.set(`p:${text(event.requestId)}`, 'permission')
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
        else if (toolId) active.set(toolId, text(update.title).slice(0, 200) || active.get(toolId) || '执行工具')
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
      task.status = event.stopReason === 'cancelled' ? 'stopped' : event.stopReason === 'error' ? 'error' : 'done'
      task.endedAt = now(); task.waitingFor = null; task.currentAction = null
      if (event.message) task.resultPreview = text(event.message).slice(-4000)
      waits.delete(id); tools.delete(id); streams.delete(id)
    }
    publish(task)
  }
  function interrupt() {
    for (const task of tasks.values()) if (!terminal.has(task.status)) {
      task.status = 'interrupted'; task.currentAction = null; task.waitingFor = null; publish(task)
    }
    waits.clear(); tools.clear(); streams.clear(); early.clear()
  }
  function query(request: TaskQuery, scope: TaskScope) {
    const visible = (task: Task) => 'taskId' in scope ? task.taskId === scope.taskId : Boolean(task.cwd && scope.cwd) && directory(task.cwd) === directory(scope.cwd)
    if (request.op === 'get') {
      const task = tasks.get(request.taskId ?? '')
      if (!task || !visible(task)) throw new Error('任务不存在或不在当前可查询范围内')
      return { observedAt: now(), task: { ...snapshot(task), resultPreview: request.includeOutput ? task.resultPreview : undefined,
        ...(request.includeRequest ? { request: task.request } : {}) } }
    }
    const list = [...tasks.values()].filter(task => visible(task) && (!request.status || task.status === request.status))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId))
    const offset = request.offset ?? 0, limit = request.limit ?? 10
    return { observedAt: now(), total: list.length, nextOffset: offset + limit < list.length ? offset + limit : null,
      tasks: list.slice(offset, offset + limit).map(task => ({ ...snapshot(task), resultPreview: undefined })) }
  }
  return { put, restart, remove, receive, interrupt, query }
}
export type TaskRegistry = ReturnType<typeof createTaskRegistry>

export function parseTaskQuery(value: unknown): TaskQuery {
  const raw = record(value)
  if (raw.op !== 'list' && raw.op !== 'get') throw new Error('未知的任务查询操作')
  if (raw.op === 'get' && (typeof raw.taskId !== 'string' || !raw.taskId || raw.taskId.length > 200)) throw new Error('taskId 无效')
  if (raw.status !== undefined && !statuses.has(text(raw.status))) throw new Error('status 无效')
  for (const key of ['limit', 'offset'] as const) if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < (key === 'limit' ? 1 : 0))) throw new Error(`${key} 无效`)
  for (const key of ['includeRequest', 'includeOutput'] as const) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw new Error(`${key} 无效`)
  return { op: raw.op, taskId: text(raw.taskId), status: raw.status as TaskStatus | undefined, limit: Math.min(Number(raw.limit ?? 10), 30),
    offset: Number(raw.offset ?? 0), includeRequest: raw.includeRequest === true, includeOutput: raw.includeOutput === true }
}
