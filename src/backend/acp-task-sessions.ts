import type { ClientSideConnection, NewSessionResponse, ResumeSessionResponse, SessionConfigOption } from '@agentclientprotocol/sdk'
import type { AcpOperations } from './acp-operations.ts'
import type { SteerResult } from '../shared/agent-info.ts'
import type { DispatchOrigin } from '../shared/request-routing/provenance.ts'
import { emitDiagnosticFailure, withOperation } from '../diagnostics/node/context.ts'

export type TaskDispatchMeta = {
  origin: DispatchOrigin
  conversationId?: string
  sourceId?: string
  threadId?: string
  hostDay?: string
}

type Choice = { id: string } & ({ type: 'select', currentValue: string } | { type: 'boolean', currentValue: boolean })
interface Attachment { attached: boolean, unattended: boolean, config: readonly Choice[] | null }
type Started = { ok: true, taskId: string } | { ok: false, reason: string }
type Acquired = { ok: true, taskId: string, attachment: Attachment } | { ok: false, reason: string }
const choices = (options: readonly SessionConfigOption[] | null | undefined): readonly Choice[] | null => options?.map(option => option.type === 'boolean'
  ? { id: option.id, type: 'boolean', currentValue: option.currentValue }
  : { id: option.id, type: 'select', currentValue: option.currentValue }) ?? null
const resultOf = (result: Acquired): Started => result.ok ? { ok: true, taskId: result.taskId } : result

/** Native attachment/request identities only. TaskRuntime owns admission, application runs, status and storage. */
export function createAcpTaskSessions({ connection, acquire, foreground, canResume, prepareFresh, operations, permissions, questions, steer, emit, describeError, goneMessage, stoppedMessage, preparePrompt = async (_id, text) => text }: {
  preparePrompt?: (id: string, text: string, meta?: TaskDispatchMeta) => Promise<string>
  connection: () => Pick<ClientSideConnection, 'setSessionConfigOption' | 'closeSession'>
  acquire: { resume: (id: string, cwd: string) => Promise<ResumeSessionResponse>, fresh: (cwd: string) => Promise<NewSessionResponse> }
  foreground: () => { sessionId: string | null, cwd: string, config: readonly SessionConfigOption[] | null }
  canResume: () => boolean, prepareFresh: () => void
  operations: Pick<AcpOperations, 'run' | 'cancelInTime' | 'count'>
  permissions: { pendingFor: (id: string) => readonly unknown[], waitingSessions: () => Set<string> }
  questions: { declineTask: (id: string) => void, pendingOf: (id: string) => readonly unknown[] }
  steer: (id: string, text: string, meta?: TaskDispatchMeta) => Promise<SteerResult>
  emit: (event: { type: string, [field: string]: unknown }) => void
  describeError: (error: unknown) => string, goneMessage: () => string, stoppedMessage: () => string
}) {
  const sessions = new Map<string, Attachment>(), retiring = new Map<string, Promise<void>>()
  let disposed = false
  const current = (id: string, attachment: Attachment) => !disposed && sessions.get(id) === attachment
  const has = (id: string) => sessions.get(id)?.attached === true

  /** A reattachment of the same native id waits for the prior close, including permission cancellation. */
  function closeNative(id: string, before: () => Promise<void> = async () => {}): Promise<void> {
    const existing = retiring.get(id)
    if (existing) return existing
    const close = (async () => {
      try { await before() }
      catch (error) { emitDiagnosticFailure('task', error, { stage: 'draining', identities: { sessionId: id } }) }
      try { await withOperation('task', () => connection().closeSession({ sessionId: id }), { stage: 'closed', identities: { sessionId: id } }) }
      catch (error) { emitDiagnosticFailure('task', error, { stage: 'closed', identities: { sessionId: id } }) }
    })()
    retiring.set(id, close)
    void close.finally(() => { if (retiring.get(id) === close) retiring.delete(id) }).catch(() => {})
    return close
  }
  /** A stale request may release an unowned id, never an id now claimed by another request. */
  async function release(id: string, attachment: Attachment) {
    if (sessions.get(id) === attachment) sessions.delete(id)
    if (!sessions.has(id)) await closeNative(id)
  }
  async function resume({ taskId, cwd = foreground().cwd }: { taskId: string, cwd?: string }): Promise<Acquired> {
    if (disposed || !canResume()) return { ok: false, reason: 'unavailable' }
    const previous = sessions.get(taskId), source = choices(foreground().config)
    const attachment: Attachment = { attached: previous?.attached ?? false, unattended: previous?.unattended ?? false, config: previous?.config ?? null }
    sessions.set(taskId, attachment)
    try {
      await retiring.get(taskId)
      if (!current(taskId, attachment)) return { ok: false, reason: 'unavailable' }
      const response = await withOperation('task', () => acquire.resume(taskId, cwd), { stage: 'recovering', identities: { sessionId: taskId } })
      if (!current(taskId, attachment)) { await release(taskId, attachment); return { ok: false, reason: 'unavailable' } }
      attachment.config = choices(response.configOptions) ?? source
      attachment.attached = true
      return { ok: true, taskId, attachment }
    } catch (error) {
      if (current(taskId, attachment)) {
        if (previous?.attached) sessions.set(taskId, previous)
        else { sessions.delete(taskId); await closeNative(taskId) }
      }
      if (!disposed) emitDiagnosticFailure('task', error, { stage: 'recovering', identities: { sessionId: taskId } })
      return { ok: false, reason: 'missing' }
    }
  }
  async function matchConfig(id: string, attachment: Attachment, source: readonly Choice[] | null): Promise<boolean> {
    for (const option of source ?? []) {
      if (!current(id, attachment)) return false
      if (attachment.config?.find(item => item.id === option.id)?.currentValue === option.currentValue) continue
      const request = option.type === 'boolean'
        ? { sessionId: id, configId: option.id, type: 'boolean' as const, value: option.currentValue }
        : { sessionId: id, configId: option.id, value: option.currentValue }
      const response = await connection().setSessionConfigOption(request)
      if (!current(id, attachment)) return false
      attachment.config = choices(response.configOptions) ?? attachment.config
    }
    return current(id, attachment)
  }
  /** A task's session, fresh (the agent hands it a brief), working where the conversation does unless told `cwd`. */
  async function start({ cwd }: { cwd?: string } = {}): Promise<Acquired> {
    const origin = foreground(), source = choices(origin.config)
    if (disposed || !origin.sessionId) return { ok: false, reason: 'missing' }
    let acquired: { id: string, attachment: Attachment } | null = null
    try {
      const response = await withOperation('task', () => acquire.fresh(cwd ?? origin.cwd), { stage: 'connecting' })
      const attachment: Attachment = { attached: true, unattended: false, config: choices(response.configOptions) ?? [] }
      acquired = { id: response.sessionId, attachment }
      if (disposed) { await release(acquired.id, attachment); return { ok: false, reason: 'unavailable' } }
      prepareFresh()
      sessions.set(acquired.id, attachment)
      if (!await matchConfig(acquired.id, acquired.attachment, source)) { await release(acquired.id, acquired.attachment); return { ok: false, reason: 'unavailable' } }
      return { ok: true, taskId: acquired.id, attachment: acquired.attachment }
    } catch (error) {
      if (acquired) await release(acquired.id, acquired.attachment)
      if (!disposed) emitDiagnosticFailure('task', error, { stage: 'connecting' })
      return { ok: false, reason: 'missing' }
    }
  }
  async function cancelTask(id: string) {
    const attachment = sessions.get(id)
    if (!attachment?.attached) return
    await operations.cancelInTime(id, () => { if (current(id, attachment)) emit({ type: 'task_end', taskId: id, stopReason: 'cancelled', message: stoppedMessage() }) })
  }
  async function closeTask(id: string) {
    const attachment = sessions.get(id)
    if (!attachment) return
    sessions.delete(id) // Revoke pending resume/config/mark immediately, before any await.
    if (!attachment.attached) return
    await closeNative(id, async () => {
      await operations.cancelInTime(id, () => {})
      questions.declineTask(id)
    })
  }
  /** A session nobody watches (a schedule's run): what it would ask the user is refused (acp-bridge.ts), not waited for. */
  async function startUnattendedTask({ cwd }: { cwd: string }): Promise<Started> {
    const started = await start({ cwd })
    if (!started.ok) return started
    const { taskId, attachment } = started
    if (!current(taskId, attachment)) return { ok: false, reason: 'unavailable' }
    attachment.unattended = true
    return { ok: true, taskId }
  }

  async function promptTask(taskId: string, text: string, meta?: TaskDispatchMeta) {
    if (disposed) return
    const attachment = sessions.get(taskId)
    if (!attachment?.attached) { emit({ type: 'task_end', taskId, stopReason: 'error', message: goneMessage() }); return }
    const effectiveMeta: TaskDispatchMeta | undefined = attachment.unattended
      ? { origin: 'unattended' }
      : meta
    try { text = await preparePrompt(taskId, text, effectiveMeta) } catch (error) { if (current(taskId, attachment)) emit({ type: 'task_end', taskId, stopReason: 'error', message: describeError(error) }); return }
    if (!current(taskId, attachment)) return
    await operations.run({
      sessionId: taskId, prompt: [{ type: 'text', text }],
      onEnd: response => { if (current(taskId, attachment)) emit({ type: 'task_end', taskId, stopReason: response.stopReason }) },
      onError: error => { if (current(taskId, attachment)) emit({ type: 'task_end', taskId, stopReason: 'error', message: describeError(error) }) },
    })
  }
  return {
    has, startUnattendedTask, promptTask, cancelTask, closeTask,
    resumeTask: async (request: Parameters<typeof resume>[0]): Promise<Started> => resultOf(await resume(request)),
    startTask: async (): Promise<Started> => resultOf(await start()),
    taskOf: (id: string) => has(id) ? id : null,
    isUnattended: (id: string) => sessions.get(id)?.unattended === true,
    async steerTask(id: string, text: string, meta?: TaskDispatchMeta): Promise<SteerResult> {
      const attachment = sessions.get(id)
      if (!attachment?.attached) return { ok: false, reason: 'missing', delivery: 'not-sent' }
      const effectiveMeta: TaskDispatchMeta | undefined = attachment.unattended
        ? { origin: 'unattended' }
        : meta
      const result = await steer(id, text, effectiveMeta)
      if (!current(id, attachment)) {
        return result.delivery === 'not-sent' ? result : { ok: false, reason: 'unavailable' }
      }
      return result
    },
    waits: (id: string) => has(id) ? { permissions: permissions.pendingFor(id), questions: questions.pendingOf(id) } : { permissions: [], questions: [] },
    workingCount() { const waiting = permissions.waitingSessions(); return operations.count(id => has(id) && !waiting.has(id)) },
    dispose() { disposed = true; sessions.clear() },
  }
}
export type AcpTaskSessions = ReturnType<typeof createAcpTaskSessions>
