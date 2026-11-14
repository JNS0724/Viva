import { randomUUID } from 'node:crypto'
import { MEMORY_QUESTION_PREFIX } from '../shared/memory-contract.ts'

interface Question {
  id: string
  question: string
  options: { label: string, description?: string }[]
}

interface Turn<Reference, Pending> {
  id: string
  refs: Map<string, Reference>
  pending: Map<string, Pending>
  observed: Map<string, Reference>
  incompleteDates: Set<string>
  ticket?: { id: string, reference: Reference, shown: boolean }
}

/** Keeps recall references and question authorization tied to a single host operation. */
export function createMemoryClarifications<Reference, Pending extends Reference>() {
  const turns = new Map<string, Turn<Reference, Pending>>()

  function track(session: string, id: string) {
    const existing = turns.get(session)
    if (existing?.id === id) return existing
    const turn: Turn<Reference, Pending> = { id, refs: new Map(), pending: new Map(), observed: new Map(), incompleteDates: new Set() }
    turns.set(session, turn)
    return turn
  }

  function issue(session: string, id: string, ref: string, check: (questionId: string, reference: Reference) => Question | null) {
    const turn = turns.get(session)
    if (turn?.id !== id) return { status: 'rejected', reason: 'unknown-dispute' } as const
    if (turn.ticket) return { status: 'rejected', reason: 'already-asked' } as const
    const reference = turn.refs.get(ref)
    if (reference === undefined) return { status: 'rejected', reason: 'stale-dispute' } as const
    const question = check(MEMORY_QUESTION_PREFIX + randomUUID(), reference)
    if (!question) return { status: 'rejected', reason: 'stale-dispute' } as const
    turn.ticket = { id: question.id, reference, shown: false }
    return { status: 'ready', question } as const
  }

  function question(session: string, id: string, questionId: string, phase: 'show' | 'check',
    check: (questionId: string, reference: Reference) => Question | null) {
    const turn = turns.get(session)
    const ticket = turn?.id === id ? turn.ticket : undefined
    if (!ticket || ticket.id !== questionId || (phase === 'show') === ticket.shown) return null
    const result = check(questionId, ticket.reference)
    if (result && phase === 'show') ticket.shown = true
    return result
  }

  return {
    track, issue, question,
    observed(session: string, turn?: string): Iterable<Reference> {
      const active = turns.get(session)
      return turn && active?.id === turn ? active.observed.values() : []
    },
    incompleteDates(session: string, turn: string): ReadonlySet<string> | undefined {
      const active = turns.get(session)
      return active?.id === turn ? active.incompleteDates : undefined
    },
    pending: (session: string) => turns.get(session)?.pending.values() ?? [],
    finish: (session: string) => turns.delete(session),
    clear: () => turns.clear(),
  }
}
