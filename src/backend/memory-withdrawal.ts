import { randomUUID } from 'node:crypto'
import type { Effects, Effect } from './effects.ts'
import type { openHistoryDb, Conversation } from './history-db.ts'
import type { StoredMessage } from './history-schema.ts'
import type { Apply } from './journal.ts'
import { memoryConversationScope, memoryProjectScope } from './memory-project.ts'
import type { HostMemoryCaller, SourceChangeInput } from '../memory/contracts/host.ts'

const HISTORY_WITHDRAWAL = 'memory.withdraw'
/** Fully replayable host edit, allocated before its first durable write. */
export type MemoryHistoryEdit = {
  oldSource: string, newSource: string, previous: Conversation, next: Conversation,
  kept: readonly StoredMessage[], keep: number, text: string,
}
type HistoryWithdrawal = {
  phase: 'intent' | 'host-committed', change: SourceChangeInput, ticket?: string,
  edit?: MemoryHistoryEdit, projectId?: string | null,
}
type History = Pick<ReturnType<typeof openHistoryDb>, 'get' | 'softDelete' | 'save' | 'fold' | 'moveRecords'>

/** Host intent precedes plugin prepare; history and its commit outbox share one transaction. */
export function createMemoryWithdrawal({ history, effects, memory, apply, changing }: {
  history: () => History, effects: () => Effects, memory: () => { call: HostMemoryCaller }, apply: Apply,
  changing: <T>(work: () => T | Promise<T>, options?: { duringSelection?: boolean }) => Promise<T>,
}) {
  const running = new Map<string, Promise<void>>()
  const pending = (key: string) => effects().get(HISTORY_WITHDRAWAL, key) as Effect<HistoryWithdrawal> | null
  function saveEdit(edit: MemoryHistoryEdit) {
    const db = history()
    const saved = db.save(edit.next, [...edit.kept, { role: 'user', text: edit.text, receipt: null, sourceId: edit.newSource }],
      { copy: { from: edit.previous.id, count: edit.keep } })
    db.fold(edit.previous.id, { into: saved.id, at: edit.keep })
    db.moveRecords({ from: edit.previous.id, to: saved.id, upTo: edit.keep })
    return saved
  }
  async function commitPending(key: string) {
    let effect = pending(key)
    if (!effect) return
    let payload = effect.payload
    if (payload.phase === 'intent') {
      const prepared = await memory().call('prepareSourceChange', payload.change)
      if (!effects().holds(effect)) throw new Error('History memory intent changed during preparation')
      payload = { ...payload, phase: 'host-committed', ticket: prepared.ticket }
      apply('history.memory.withdrawal', { id: payload.change.conversation, operationId: payload.change.operationId }, () => {
        if (payload.edit) saveEdit(payload.edit)
        else history().softDelete(payload.change.conversation)
        effects().queue(HISTORY_WITHDRAWAL, key, payload)
      })
      effect = pending(key)!
    }
    if (!payload.ticket) throw new Error('Prepared source change is missing its ticket')
    await memory().call('commitSourceChange', { operationId: payload.change.operationId, ticket: payload.ticket })
  }
  async function finishPending(key: string) {
    const effect = pending(key)
    if (!effect) return
    const payload = effect.payload
    if (payload.phase !== 'host-committed') throw new Error('History withdrawal has not committed')
    if (payload.edit) {
      const { edit, projectId } = payload
      if (edit.next.sessionId) {
        const project = projectId ? { kind: 'project' as const, id: projectId } : undefined
        // This only maps host identity. The plugin ingests the original when DSH durably receives it.
        await memory().call('sourceAlias', { operationId: edit.newSource, sourceId: edit.newSource,
          session: edit.next.sessionId, conversation: edit.next.id, text: edit.text,
          context: memoryConversationScope(edit.next.topicId ?? edit.next.id, project), project })
      }
    }
    apply('history.memory.withdrawal.finished', { operationId: payload.change.operationId }, () => effects().finishGeneration(effect!))
  }
  function applyKey(key: string, phase: 'commit' | 'finish' | 'all' = 'all'): Promise<void> {
    // Recovery and live actions may overlap. Serialize each key, but do not let a failed alias
    // prevent a later recovery pass from committing other already-prepared operations.
    const previous = running.get(key) ?? Promise.resolve()
    const work = previous.catch(() => {}).then(async () => {
      if (phase !== 'finish') await commitPending(key)
      if (phase !== 'commit') await finishPending(key)
    }).finally(() => { if (running.get(key) === work) running.delete(key) })
    running.set(key, work)
    return work
  }
  async function applyBatch(keys: readonly string[]) {
    const failures = new Map<string, unknown>()
    for (const key of keys) {
      try { await applyKey(key, 'commit') } catch (error) { failures.set(key, error) }
    }
    // All prepared operations must cross host commit before aliases can require a ready owner.
    for (const key of keys) if (!failures.has(key)) {
      try { await applyKey(key, 'finish') } catch (error) { failures.set(key, error) }
    }
    return failures
  }
  return {
    register() {
      effects().runs(HISTORY_WITHDRAWAL, async jobs => {
        const keys = jobs.filter(job => effects().holds(job)).map(job => job.key)
        try {
          const failures = await changing(() => applyBatch(keys))
          return new Map(keys.map(key => [key, failures.has(key) ? 'retry' as const : 'done' as const]))
        } catch {
          return new Map(keys.map(key => [key, 'retry' as const]))
        }
      })
    },
    async recover() {
      const keys = effects().list().filter(effect => effect.kind === HISTORY_WITHDRAWAL).map(effect => effect.key)
      const failures = await applyBatch(keys)
      if (failures.size) throw new AggregateError(failures.values(), 'Some history memory withdrawals remain pending')
    },
    deleteHistory(id: string) {
      return changing(async () => {
        if (!pending(id)) apply('history.memory.withdrawal.intent', { id }, () => {
          const ids = history().get(id)?.messages.flatMap(row => row.sourceId ? [row.sourceId] : []) ?? []
          effects().queue(HISTORY_WITHDRAWAL, id, { phase: 'intent', change: { operationId: randomUUID(), ids, conversation: id } } satisfies HistoryWithdrawal)
        })
        await applyKey(id)
      })
    },
    commitEdit(edit: MemoryHistoryEdit) {
      return changing(async () => {
        if (!pending(edit.newSource)) {
          const bound = edit.next.sessionId ? await memory().call('sessionProject', { args: [edit.next.sessionId] }) : undefined
          const previous = edit.previous.sessionId ? await memory().call('sessionProject', { args: [edit.previous.sessionId] }) : undefined
          const projectId = (bound ?? previous ?? memoryProjectScope(edit.next.cwd)?.id) || null
          apply('history.memory.withdrawal.intent', { id: edit.previous.id, sourceId: edit.oldSource }, () => {
            effects().queue(HISTORY_WITHDRAWAL, edit.newSource, { phase: 'intent', edit, projectId,
              change: { operationId: randomUUID(), ids: [edit.oldSource], conversation: edit.previous.id, onlySources: true,
                replacement: { sourceId: edit.newSource, segmentId: edit.next.id, projectId } },
            } satisfies HistoryWithdrawal)
          })
        }
        await applyKey(edit.newSource)
        const saved = history().get(edit.next.id)?.conversation
        if (!saved) throw new Error('Committed history edit is missing')
        return saved
      }, { duringSelection: true })
    },
  }
}
