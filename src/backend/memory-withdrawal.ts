import type { Effects, Effect } from './effects.ts'
import type { openHistoryDb, Conversation } from './history-db.ts'
import type { Apply } from './journal.ts'
import { memoryConversationScope, memoryProjectScope } from './memory-project.ts'
import type { MemoryRuntime, MemoryWithdrawal } from './memory-runtime.ts'

const HISTORY_WITHDRAWAL = 'memory.withdraw'
type HistoryWithdrawal = MemoryWithdrawal & { replacement?: { sourceId: string, segmentId: string, projectId?: string | null } }

/** History owns its transaction. The effect keeps the memory operation recoverable across the databases. */
export function createMemoryWithdrawal({ history, effects, memory, apply, changing }: {
  history: () => Pick<ReturnType<typeof openHistoryDb>, 'get' | 'softDelete'>,
  effects: () => Effects,
  memory: () => Pick<MemoryRuntime, 'holdWithdrawal' | 'releaseWithdrawal' | 'withdraw' | 'accept' | 'sessionProject' | 'recordSessionProject'>,
  apply: Apply,
  changing: <T>(work: () => T | Promise<T>, options?: { duringSelection?: boolean }) => Promise<T>,
}) {
  function applyPending({ payload, ...effect }: Effect<HistoryWithdrawal>) {
    const runtime = memory()
    const { conversation, ids, onlySources, replacement } = payload
    const held = onlySources ? ids : undefined
    runtime.holdWithdrawal(conversation, held)
    runtime.withdraw(payload)
    if (replacement) {
      const segment = history().get(replacement.segmentId)
      const message = segment?.messages.find(row => row.role === 'user' && row.sourceId === replacement.sourceId)
      if (segment && message) {
        const { id, sessionId, topicId } = segment.conversation
        const bound = sessionId ? runtime.sessionProject(sessionId) : undefined
        const projectId = bound === undefined ? replacement.projectId : bound || null
        // The Git worktree can change while an effect waits, so its current directory is not provenance.
        if (projectId !== undefined && (replacement.projectId === undefined || projectId === replacement.projectId)) {
          const project = projectId ? { kind: 'project' as const, id: projectId } : undefined
          if (sessionId) runtime.recordSessionProject(sessionId, projectId ?? '')
          runtime.accept(message.text, { conversation: id, session: sessionId, context: memoryConversationScope(topicId ?? id, project), project }, replacement.sourceId)
        }
      }
    }
    effects().finishGeneration(effect)
    runtime.releaseWithdrawal(conversation, held)
  }

  const pending = (key: string) => effects().get(HISTORY_WITHDRAWAL, key) as Effect<HistoryWithdrawal> | null
  function applyKey(key: string) {
    const effect = pending(key)
    if (effect) applyPending(effect)
  }
  return {
    register() {
      effects().runs(HISTORY_WITHDRAWAL, async jobs => {
        const outcomes = new Map<string, 'done' | 'retry'>()
        for (const job of jobs) {
          if (!effects().holds(job)) continue
          try {
            await changing(() => applyKey(job.key))
            outcomes.set(job.key, 'done')
          } catch {
            outcomes.set(job.key, 'retry')
          }
        }
        return outcomes
      })
    },
    recover() {
      for (const effect of effects().list()) if (effect.kind === HISTORY_WITHDRAWAL) applyPending(effect as Effect<HistoryWithdrawal>)
    },
    deleteHistory(id: string) {
      return changing(() => {
        if (!pending(id)) apply('history.memory.withdrawal', { id }, () => {
          const ids = history().get(id)?.messages.flatMap(row => row.sourceId ? [row.sourceId] : []) ?? []
          history().softDelete(id)
          effects().queue(HISTORY_WITHDRAWAL, id, { ids, conversation: id } satisfies HistoryWithdrawal)
        })
        applyKey(id)
      })
    },
    commitEdit({ oldSource, newSource, previous }: { oldSource: string, newSource: string, previous: Conversation }, save: () => Conversation) {
      let next: Conversation | undefined
      return changing(() => {
        if (!next) next = apply('history.memory.withdrawal', { id: previous.id, sourceId: oldSource }, () => {
          const saved = save()
          const runtime = memory()
          const replacementProject = saved.sessionId ? runtime.sessionProject(saved.sessionId) : undefined
          const previousProject = previous.sessionId ? runtime.sessionProject(previous.sessionId) : undefined
          const projectId = (replacementProject ?? previousProject ?? memoryProjectScope(saved.cwd)?.id) || null
          effects().queue(HISTORY_WITHDRAWAL, newSource, {
            ids: [oldSource], conversation: previous.id, onlySources: true,
            replacement: { sourceId: newSource, segmentId: saved.id, projectId },
          } satisfies HistoryWithdrawal)
          return saved
        }).value
        applyKey(newSource)
        return next
      }, { duringSelection: true })
    },
  }
}
