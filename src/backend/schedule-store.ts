import type { DatabaseSync } from 'node:sqlite'
import {
  createAtScheduleRecord, createCronScheduleRecord, createDailyScheduleRecord, createWeeklyScheduleRecord, isRecurringScheduleRecord,
  resolveRecurringOccurrence, ScheduleId,
} from '@deepseek-ai/dsh-schedule'
import type { AtInput, CronInput, DailyInput, ScheduleRecord, WeeklyInput } from '@deepseek-ai/dsh-schedule'

/**
 * Schedules (system-design §12.2): a time and a prompt, made by talking and kept once the user says yes. A schedule's
 * record is `dsh-schedule`'s own (once, daily, weekly or cron, with its time zone and DST rules), so its time
 * arithmetic is dsh's, not Viva's. This store is their one writer; it says which are due and moves each past the
 * occurrence taken, so one occurrence is taken once (its key: the schedule's id and the occurrence's time).
 */
export type ScheduleRule =
  | { kind: 'at', at: AtInput }
  | { kind: 'daily', daily: DailyInput }
  | { kind: 'weekly', weekly: WeeklyInput }
  | { kind: 'cron', cron: CronInput }

export type ScheduleStatus = 'active' | 'paused' | 'ended'

export interface Schedule {
  id: string
  record: ScheduleRecord
  status: ScheduleStatus
  /** The conversation it was made in, for where its results came from. */
  conversationId: string | null
  createdAt: number
}

/** One occurrence taken: its key (one item per key in 动态) and the schedule as it was. */
export interface Occurrence { key: string, at: string, schedule: Schedule }

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    record TEXT NOT NULL,
    status TEXT NOT NULL,
    conversation_id TEXT,
    created_at INTEGER NOT NULL
  );
`

type Row = Record<string, unknown>
const scheduleOf = (row: Row): Schedule => ({
  id: String(row.id),
  record: JSON.parse(String(row.record)) as ScheduleRecord,
  status: String(row.status) as ScheduleStatus,
  conversationId: row.conversation_id === null ? null : String(row.conversation_id),
  createdAt: Number(row.created_at),
})

/** dsh's record for a rule: its first time strictly after `now`; dsh throws on what it does not accept. */
function recordOf(id: string, title: string, prompt: string, rule: ScheduleRule, now: number): ScheduleRecord {
  const sid = ScheduleId(id)
  if (rule.kind === 'at') return createAtScheduleRecord(sid, prompt, rule.at, now, title)
  if (rule.kind === 'daily') return createDailyScheduleRecord(sid, prompt, rule.daily, now, title)
  if (rule.kind === 'weekly') return createWeeklyScheduleRecord(sid, prompt, rule.weekly, now, title)
  return createCronScheduleRecord(sid, prompt, rule.cron, now, title)
}

export function openScheduleStore({ db, now = Date.now, newId = () => `s${crypto.randomUUID().slice(0, 8)}` }: { db: DatabaseSync, now?: () => number, newId?: () => string }) {
  db.exec(SCHEMA)
  const get = (id: string): Schedule | null => {
    const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Row | undefined
    return row ? scheduleOf(row) : null
  }
  const write = (schedule: Schedule) => db.prepare('UPDATE schedules SET record = ?, status = ? WHERE id = ?')
    .run(JSON.stringify(schedule.record), schedule.status, schedule.id)

  function create(input: { title: string, prompt: string, rule: ScheduleRule, conversationId?: string | null }): Schedule {
    const id = newId()
    const record = recordOf(id, input.title, input.prompt, input.rule, now())
    db.prepare('INSERT INTO schedules (id, record, status, conversation_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, JSON.stringify(record), 'active', input.conversationId ?? null, now())
    return get(id) as Schedule
  }

  /** Its title, prompt or time changed; a new time is reckoned from now, as dsh does. */
  function update(id: string, changes: { title?: string, prompt?: string, rule?: ScheduleRule }): Schedule | null {
    const found = get(id)
    if (!found || found.status === 'ended') return null
    const title = changes.title ?? found.record.title
    const prompt = changes.prompt ?? found.record.prompt
    const record = changes.rule ? recordOf(id, title, prompt, changes.rule, now()) : { ...found.record, title, prompt }
    write({ ...found, record })
    return get(id)
  }

  function setPaused(id: string, paused: boolean): Schedule | null {
    const found = get(id)
    if (!found || found.status === 'ended') return null
    write({ ...found, status: paused ? 'paused' : 'active' })
    return get(id)
  }

  const remove = (id: string): boolean => Number(db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes) > 0

  /** All but the ended, the soonest first. */
  const list = (): Schedule[] => (db.prepare(`SELECT * FROM schedules WHERE status != 'ended'`).all() as Row[]).map(scheduleOf)
    .toSorted((a, b) => Date.parse(a.record.scheduledAt) - Date.parse(b.record.scheduledAt))

  /** When the next active one is due, or null. */
  const nextDueAt = (): number | null => {
    const active = list().filter((schedule) => schedule.status === 'active')
    return active.length ? Date.parse(active[0].record.scheduledAt) : null
  }

  /**
   * Takes every active schedule due by now: each moves past its occurrence (a recurring one to its next time, one
   * that runs once to ended) and comes back keyed by that occurrence. Missed ones are one occurrence each, the latest
   * (dsh's rule), not every one missed.
   */
  function takeDue(): Occurrence[] {
    const at = now()
    return list().filter((schedule) => schedule.status === 'active' && Date.parse(schedule.record.scheduledAt) <= at).map((schedule) => {
      const { record } = schedule
      if (!isRecurringScheduleRecord(record)) {
        write({ ...schedule, status: 'ended' })
        return { key: `${schedule.id}@${record.scheduledAt}`, at: record.scheduledAt, schedule }
      }
      const { occurrenceAt, nextScheduledAt } = resolveRecurringOccurrence(record, at)
      write(nextScheduledAt ? { ...schedule, record: { ...record, scheduledAt: nextScheduledAt } as ScheduleRecord } : { ...schedule, status: 'ended' })
      return { key: `${schedule.id}@${occurrenceAt}`, at: occurrenceAt, schedule }
    })
  }

  /** What `create` would keep, kept nowhere: for the card that asks the user (dsh throws on what it refuses). */
  const preview = (input: { title: string, prompt: string, rule: ScheduleRule }): ScheduleRecord => recordOf('preview', input.title, input.prompt, input.rule, now())

  return { create, update, setPaused, remove, get, list, nextDueAt, takeDue, preview }
}

export type ScheduleStore = ReturnType<typeof openScheduleStore>
