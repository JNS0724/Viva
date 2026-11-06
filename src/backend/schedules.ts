import type { DatabaseSync } from 'node:sqlite'
import { t } from '../shared/i18n/translate.ts'
import { openScheduleStore, type Schedule, type ScheduleRule } from './schedule-store.ts'
import type { ScheduleAction } from './tasks-channel.ts'

/**
 * Schedules as the model and the user handle them (system-design §12.2), natural language first: the model proposes,
 * lists, changes, pauses and deletes them with its tools (plugins/tasks, schedule_*); one proposed is kept only once
 * the user says yes on its card in the window (`schedule_propose`, then `accept`). What runs them when they are due
 * is the timer's (schedule-timer.ts).
 */
export interface ScheduleProposal { proposalId: string, title: string, prompt: string, rule: ScheduleRule, firstAt: string }
/** A schedule as the model and the window see it. */
export interface ScheduleView { id: string, title: string, prompt: string, kind: string, nextAt: string, status: string }

const viewOf = (schedule: Schedule): ScheduleView => ({
  id: schedule.id, title: schedule.record.title, prompt: schedule.record.prompt, kind: schedule.record.kind,
  nextAt: schedule.record.scheduledAt, status: schedule.status,
})

export function createSchedules({ db, emit, changed = () => {}, now = Date.now, newId = () => `p${crypto.randomUUID().slice(0, 8)}` }: {
  db: DatabaseSync
  /** To the window: a proposal for its card. */
  emit: (event: { type: 'schedule_propose', proposal: ScheduleProposal }) => void
  /** The list changed (the timer looks again; the window reloads it). */
  changed?: () => void
  now?: () => number
  newId?: () => string
}) {
  const store = openScheduleStore({ db, now })
  /** Proposals waiting on the user's yes, by id: kept in memory, gone with the app (the card then says so). */
  let proposals = new Map<string, ScheduleProposal & { conversationId: string | null }>()

  function propose(action: Extract<ScheduleAction, { op: 'schedule_create' }>, conversationId: string | null) {
    const rule = action.rule as unknown as ScheduleRule
    const record = store.preview({ title: action.title, prompt: action.prompt, rule })
    const proposal: ScheduleProposal = { proposalId: newId(), title: action.title, prompt: action.prompt, rule, firstAt: record.scheduledAt }
    proposals = new Map([...proposals, [proposal.proposalId, { ...proposal, conversationId }]])
    emit({ type: 'schedule_propose', proposal })
    return { proposed: true, firstAt: record.scheduledAt, note: t('main.schedules.proposed') }
  }

  /** The user's yes on a card: the schedule kept. */
  function accept(proposalId: string): ScheduleView {
    const proposal = proposals.get(proposalId)
    if (!proposal) throw new Error(t('main.schedules.proposal.gone'))
    proposals = new Map([...proposals].filter(([id]) => id !== proposalId))
    const schedule = store.create({ title: proposal.title, prompt: proposal.prompt, rule: proposal.rule, conversationId: proposal.conversationId })
    changed()
    return viewOf(schedule)
  }

  function decline(proposalId: string): void {
    proposals = new Map([...proposals].filter(([id]) => id !== proposalId))
  }

  const list = (): ScheduleView[] => store.list().map(viewOf)

  function update(id: string, changes: { title?: string, prompt?: string, rule?: ScheduleRule, paused?: boolean }): ScheduleView {
    const { paused, ...rest } = changes
    let found = Object.keys(rest).length ? store.update(id, rest) : store.get(id)
    if (found && paused !== undefined) found = store.setPaused(id, paused)
    if (!found || found.status === 'ended') throw new Error(t('main.schedules.not.found'))
    changed()
    return viewOf(found)
  }

  function remove(id: string): { deleted: boolean } {
    const deleted = store.remove(id)
    if (deleted) changed()
    return { deleted }
  }

  /** What the model asked (tasks-channel.ts ScheduleAction), from the conversation on screen. */
  function act(action: ScheduleAction, conversationId: string | null): unknown {
    if (action.op === 'schedule_create') return propose(action, conversationId)
    if (action.op === 'schedule_list') return list()
    if (action.op === 'schedule_delete') return remove(action.id)
    const { op: _op, id, rule, ...rest } = action
    return update(id, { ...rest, ...(rule ? { rule: rule as unknown as ScheduleRule } : {}) })
  }

  return { act, accept, decline, list, update, remove, store }
}

export type Schedules = ReturnType<typeof createSchedules>
