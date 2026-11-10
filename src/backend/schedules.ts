import type { DatabaseSync } from 'node:sqlite'
import { t } from '../shared/i18n/translate.ts'
import { journaled, type Apply } from './journal.ts'
import { openScheduleStore, type Schedule, type ScheduleRule } from './schedule-store.ts'
import { parseScheduleWords, type ScheduleAction } from './tasks-channel.ts'

/**
 * Schedules as the model and the user handle them (system-design §12.2), natural language first: the model proposes,
 * lists, changes, pauses and deletes them with its tools (plugins/tasks, schedule_*); one proposed is kept only once
 * the user says yes on its card in the window (`schedule_propose`, then `accept`). What runs them when they are due
 * is schedule-runs.ts's.
 */
export interface ScheduleProposal { proposalId: string, title: string, prompt: string, rule: ScheduleRule, firstAt: string }
/** A schedule as the model and the window see it. */
export interface ScheduleView { id: string, title: string, prompt: string, kind: string, nextAt: string, status: string }

/** dsh-schedule's refusal of a time, in the user's words: one gone by, or one it cannot read; anything else as it is. */
function timeRefused(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'not_future') return new Error(t('main.schedules.time.past'))
  if (code === 'invalid_rule') return new Error(t('main.schedules.time.invalid'))
  return err
}

const viewOf = (schedule: Schedule): ScheduleView => ({
  id: schedule.id, title: schedule.record.title, prompt: schedule.record.prompt, kind: schedule.record.kind,
  nextAt: schedule.record.scheduledAt, status: schedule.status,
})

/** The schedules' writes made by the user or the model, each an event (journal.ts); being run is schedule-runs.ts's. */
const SCHEDULE_WRITES = Object.freeze(['create', 'update', 'setPaused', 'remove'] as const)

export function createSchedules({ db, apply, emit, changed = () => {}, now = Date.now, newId = () => `p${crypto.randomUUID().slice(0, 8)}` }: {
  db: DatabaseSync
  /** The event core's apply: each write and its event together. Without it (tests), plain writes. */
  apply?: Apply
  /** To the window: a proposal for its card. */
  emit: (event: { type: 'schedule_propose', proposal: ScheduleProposal }) => void
  /** The list changed (the timer looks again; the window reloads it). */
  changed?: () => void
  now?: () => number
  newId?: () => string
}) {
  const opened = openScheduleStore({ db, now })
  const store = apply ? journaled(opened, 'schedule', SCHEDULE_WRITES, apply) : opened
  /** Proposals waiting on the user's yes, by id: kept in memory, gone with the app (the card then says so). */
  let proposals = new Map<string, ScheduleProposal & { conversationId: string | null, cwd: string }>()

  function propose(action: Extract<ScheduleAction, { op: 'schedule_create' }>, conversationId: string | null, cwd: string) {
    const rule = action.rule as unknown as ScheduleRule
    const record = store.preview({ title: action.title, prompt: action.prompt, rule })
    const proposal: ScheduleProposal = { proposalId: newId(), title: action.title, prompt: action.prompt, rule, firstAt: record.scheduledAt }
    proposals = new Map([...proposals, [proposal.proposalId, { ...proposal, conversationId, cwd }]])
    emit({ type: 'schedule_propose', proposal })
    return { proposed: true, firstAt: record.scheduledAt, note: t('main.schedules.proposed') }
  }

  /**
   * The user's yes on a card: the schedule kept, as proposed or as the user changed it there (`edits`: its name,
   * what it does and its rule, all three, checked as the model's own are).
   */
  function accept(proposalId: string, edits?: unknown): ScheduleView {
    const proposal = proposals.get(proposalId)
    if (!proposal) throw new Error(t('main.schedules.proposal.gone'))
    const edited = edits === undefined ? null : parseScheduleWords(edits)
    const words = edited ? { ...edited, rule: edited.rule as unknown as ScheduleRule } : proposal
    // Let go only once kept: a save that fails leaves the card to be answered again.
    let schedule: Schedule
    try {
      schedule = store.create({ title: words.title, prompt: words.prompt, rule: words.rule, cwd: proposal.cwd, conversationId: proposal.conversationId })
    } catch (err) {
      throw timeRefused(err)
    }
    proposals = new Map([...proposals].filter(([id]) => id !== proposalId))
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

  /** What the model asked (tasks-channel.ts ScheduleAction), from the conversation on screen, in its working folder. */
  function act(action: ScheduleAction, conversationId: string | null, cwd: string): unknown {
    if (action.op === 'schedule_create') return propose(action, conversationId, cwd)
    if (action.op === 'schedule_list') return list()
    if (action.op === 'schedule_delete') return remove(action.id)
    const { op: _op, id, rule, ...rest } = action
    return update(id, { ...rest, ...(rule ? { rule: rule as unknown as ScheduleRule } : {}) })
  }

  return { act, accept, decline, list, update, remove, store }
}

export type Schedules = ReturnType<typeof createSchedules>
