import type { ClientSideConnection, NewSessionResponse, ResumeSessionResponse, SessionConfigOption } from '@agentclientprotocol/sdk'
import type { AcpOperations } from './acp-operations.ts'
import type { ForkPoint, ForkResult } from './fork-channel.ts'
import type { SteerResult } from '../shared/agent-info.ts'

type Choice = { id: string } & ({ type: 'select', currentValue: string } | { type: 'boolean', currentValue: boolean })
interface Attachment { attached: boolean, unattended: boolean, config: readonly Choice[] | null }
type Started = { ok: true, taskId: string } | { ok: false, reason: string }
type Acquired = { ok: true, taskId: string, attachment: Attachment } | { ok: false, reason: string }
const choices = (options: readonly SessionConfigOption[] | null | undefined): readonly Choice[] | null => options?.map(option => option.type === 'boolean'
  ? { id: option.id, type: 'boolean', currentValue: option.currentValue }
  : { id: option.id, type: 'select', currentValue: option.currentValue }) ?? null
const resultOf = (result: Acquired): Started => result.ok ? { ok: true, taskId: result.taskId } : result

/** Native attachment/request identities only. TaskRuntime owns admission, application runs, status and storage. */
export function createAcpTaskSessions({ connection, acquire, foreground, canResume, prepareFresh, fork, operations, permissions, questions, steer, markReadOnly, emit, describeError, goneMessage, stoppedMessage }: {
  connection: () => Pick<ClientSideConnection, 'setSessionConfigOption' | 'closeSession'>
  acquire: { resume: (id: string, cwd: string) => Promise<ResumeSessionResponse>, fresh: (cwd: string) => Promise<NewSessionResponse> }
  foreground: () => { sessionId: string | null, cwd: string, config: readonly SessionConfigOption[] | null }
  canResume: () => boolean, prepareFresh: () => void
  fork: (point: ForkPoint) => Promise<ForkResult>
  operations: Pick<AcpOperations, 'run' | 'cancelInTime' | 'count'>
  permissions: { pendingFor: (id: string) => readonly unknown[], waitingSessions: () => Set<string> }
  questions: { declineTask: (id: string) => void, pendingOf: (id: string) => readonly unknown[] }
  steer: (id: string, text: string) => Promise<SteerResult>
  markReadOnly: (id: string) => Promise<boolean>
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
      catch (error) { console.error('[acp-bridge] task wait cleanup failed:', describeError(error)) }
      try { await connection().closeSession({ sessionId: id }) }
      catch (error) { console.error('[acp-bridge] closing a task failed:', describeError(error)) }
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
      const response = await acquire.resume(taskId, cwd)
      if (!current(taskId, attachment)) { await release(taskId, attachment); return { ok: false, reason: 'unavailable' } }
      attachment.config = choices(response.configOptions) ?? source
      attachment.attached = true
      return { ok: true, taskId, attachment }
    } catch (error) {
      if (current(taskId, attachment)) {
        if (previous?.attached) sessions.set(taskId, previous)
        else { sessions.delete(taskId); await closeNative(taskId) }
      }
      if (!disposed) console.error('[acp-bridge] could not take up the task again:', describeError(error))
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
  async function start({ words, afresh = false, cwd }: { words?: string, afresh?: boolean, cwd?: string } = {}): Promise<Acquired> {
    const origin = foreground(), source = choices(origin.config)
    if (disposed || !origin.sessionId) return { ok: false, reason: 'missing' }
    const directory = afresh && cwd ? cwd : origin.cwd
    let acquired: { id: string, attachment: Attachment } | null = null
    try {
      const forked = afresh ? { ok: false as const } : await fork(words ? { words, occurrence: 0 } : {})
      if (disposed) { if (forked.ok) await closeNative(forked.sessionId); return { ok: false, reason: 'unavailable' } }
      if (forked.ok) {
        const taken = await resume({ taskId: forked.sessionId, cwd: directory })
        if (!taken.ok) return taken
        acquired = { id: taken.taskId, attachment: taken.attachment }
      } else {
        const response = await acquire.fresh(directory)
        const attachment: Attachment = { attached: true, unattended: false, config: choices(response.configOptions) ?? [] }
        acquired = { id: response.sessionId, attachment }
        if (disposed) { await release(acquired.id, attachment); return { ok: false, reason: 'unavailable' } }
        prepareFresh()
        sessions.set(acquired.id, attachment)
      }
      if (!await matchConfig(acquired.id, acquired.attachment, source)) { await release(acquired.id, acquired.attachment); return { ok: false, reason: 'unavailable' } }
      return { ok: true, taskId: acquired.id, attachment: acquired.attachment }
    } catch (error) {
      if (acquired) await release(acquired.id, acquired.attachment)
      if (!disposed) console.error('[acp-bridge] could not start a task:', describeError(error))
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
  async function startReadOnlyTask({ cwd }: { cwd: string }): Promise<Started> {
    const started = await start({ afresh: true, cwd })
    if (!started.ok) return started
    const { taskId, attachment } = started
    if (!current(taskId, attachment)) return { ok: false, reason: 'unavailable' }
    attachment.unattended = true
    try {
      if (await markReadOnly(taskId) && current(taskId, attachment)) return { ok: true, taskId }
    } catch (error) {
      if (!disposed) console.error('[acp-bridge] could not mark a read-only task:', describeError(error))
    }
    await release(taskId, attachment)
    return { ok: false, reason: 'unavailable' }
  }
  async function promptTask(taskId: string, text: string) {
    if (disposed) return
    const attachment = sessions.get(taskId)
    if (!attachment?.attached) { emit({ type: 'task_end', taskId, stopReason: 'error', message: goneMessage() }); return }
    await operations.run({
      sessionId: taskId, prompt: [{ type: 'text', text }],
      onEnd: response => { if (current(taskId, attachment)) emit({ type: 'task_end', taskId, stopReason: response.stopReason }) },
      onError: error => { if (current(taskId, attachment)) emit({ type: 'task_end', taskId, stopReason: 'error', message: describeError(error) }) },
    })
  }
  return {
    has, startReadOnlyTask, promptTask, cancelTask, closeTask,
    resumeTask: async (request: Parameters<typeof resume>[0]): Promise<Started> => resultOf(await resume(request)),
    startTask: async (request: Parameters<typeof start>[0] = {}): Promise<Started> => resultOf(await start(request)),
    taskOf: (id: string) => has(id) ? id : null,
    isUnattended: (id: string) => sessions.get(id)?.unattended === true,
    async steerTask(id: string, text: string): Promise<SteerResult> {
      const attachment = sessions.get(id)
      if (!attachment?.attached) return { ok: false, reason: 'missing' }
      const result = await steer(id, text)
      return current(id, attachment) ? result : { ok: false, reason: 'missing' }
    },
    waits: (id: string) => has(id) ? { permissions: permissions.pendingFor(id), questions: questions.pendingOf(id) } : { permissions: [], questions: [] },
    workingCount() { const waiting = permissions.waitingSessions(); return operations.count(id => has(id) && !waiting.has(id)) },
    dispose() { disposed = true; sessions.clear() },
  }
}
export type AcpTaskSessions = ReturnType<typeof createAcpTaskSessions>
