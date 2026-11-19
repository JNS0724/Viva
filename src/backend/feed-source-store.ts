import type { DatabaseSync } from 'node:sqlite'
import {
  createCronScheduleRecord, createDailyScheduleRecord, createWeeklyScheduleRecord,
  resolveRecurringOccurrence, ScheduleId,
} from '@deepseek-ai/dsh-schedule'
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule'
import {
  MAX_SOURCE_INSTRUCTION_CHARS, MAX_SOURCE_NAME_CHARS, MAX_SOURCE_PLUGIN_CHARS,
  parseFeedSourceSchedule, toDshScheduleRule,
  type FeedSourceLastStatus, type FeedSourceSchedule, type FeedSourceStatus, type FeedSourceView,
} from '../shared/feed-source.ts'
import { t } from '../shared/i18n/translate.ts'

/**
 * Plugin-backed data sources for 动态 (system-design §12.2). Each source binds an installed dsh plugin
 * to an explicit recurring schedule and a natural-language instruction. Multiple sources may bind the
 * same plugin with different schedules or rules. Schedule arithmetic uses dsh-schedule records so
 * time zone, DST and missed-occurrence rules match conversation schedules.
 */

export interface FeedSource {
  id: string
  pluginName: string
  name: string
  instruction: string
  schedule: FeedSourceSchedule
  record: ScheduleRecord
  status: FeedSourceStatus
  cwd: string
  cursor: unknown | null
  lastRunAt: number | null
  lastStatus: FeedSourceLastStatus
  lastMessage: string | null
  lastPublishedCount: number
  revision: number
  createdAt: number
  updatedAt: number
}

export interface FeedSourceOccurrence {
  key: string
  at: string
  source: FeedSource
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS feed_sources (
    id TEXT PRIMARY KEY,
    plugin_name TEXT NOT NULL,
    name TEXT NOT NULL,
    instruction TEXT NOT NULL,
    schedule TEXT NOT NULL,
    record TEXT NOT NULL,
    status TEXT NOT NULL,
    cwd TEXT NOT NULL,
    cursor TEXT,
    last_run_at INTEGER,
    last_status TEXT NOT NULL DEFAULT 'idle',
    last_message TEXT,
    last_published_count INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS feed_sources_created ON feed_sources (created_at DESC);
`

type Row = Record<string, unknown>

const sourceOf = (row: Row): FeedSource => ({
  id: String(row.id),
  pluginName: String(row.plugin_name),
  name: String(row.name),
  instruction: String(row.instruction),
  schedule: JSON.parse(String(row.schedule)) as FeedSourceSchedule,
  record: JSON.parse(String(row.record)) as ScheduleRecord,
  status: String(row.status) as FeedSourceStatus,
  cwd: String(row.cwd),
  cursor: typeof row.cursor === 'string' ? JSON.parse(row.cursor) : null,
  lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at),
  lastStatus: String(row.last_status ?? 'idle') as FeedSourceLastStatus,
  lastMessage: typeof row.last_message === 'string' ? row.last_message : null,
  lastPublishedCount: Number(row.last_published_count ?? 0),
  revision: Number(row.revision ?? 0),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

export const feedSourceViewOf = (source: FeedSource): FeedSourceView => ({
  id: source.id,
  pluginName: source.pluginName,
  name: source.name,
  instruction: source.instruction,
  schedule: source.schedule,
  status: source.status,
  nextAt: source.record.scheduledAt,
  lastRunAt: source.lastRunAt,
  lastStatus: source.lastStatus,
  lastMessage: source.lastMessage,
  lastPublishedCount: source.lastPublishedCount,
  createdAt: source.createdAt,
  updatedAt: source.updatedAt,
})

function requireText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new Error(`invalid ${label}`)
  }
  return value.trim()
}

function scheduleRefused(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'not_future') return new Error(t('main.schedules.time.past'))
  if (code === 'invalid_rule') return new Error(t('main.schedules.time.invalid'))
  return err
}

function recordOf(id: string, name: string, instruction: string, schedule: FeedSourceSchedule, now: number): ScheduleRecord {
  const sid = ScheduleId(id)
  const rule = toDshScheduleRule(schedule)
  try {
    if (rule.kind === 'daily') return createDailyScheduleRecord(sid, instruction, rule.daily, now, name)
    if (rule.kind === 'weekly') return createWeeklyScheduleRecord(sid, instruction, rule.weekly, now, name)
    return createCronScheduleRecord(sid, instruction, rule.cron, now, name)
  } catch (err) {
    throw scheduleRefused(err)
  }
}

export function openFeedSourceStore({ db, now = Date.now, newId = () => `fs${crypto.randomUUID().slice(0, 8)}` }: {
  db: DatabaseSync
  now?: () => number
  newId?: () => string
}) {
  db.exec(SCHEMA)

  const get = (id: string): FeedSource | null => {
    const row = db.prepare('SELECT * FROM feed_sources WHERE id = ?').get(id) as Row | undefined
    return row ? sourceOf(row) : null
  }

  function create(input: { pluginName: string, name?: string, instruction: string, schedule: unknown, cwd: string }): FeedSource {
    const pluginName = requireText(input.pluginName, MAX_SOURCE_PLUGIN_CHARS, 'pluginName')
    const rawName = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : pluginName
    const name = requireText(rawName, MAX_SOURCE_NAME_CHARS, 'name')
    const instruction = requireText(input.instruction, MAX_SOURCE_INSTRUCTION_CHARS, 'instruction')
    const schedule = parseFeedSourceSchedule(input.schedule)
    const cwd = requireText(input.cwd, 4_096, 'cwd')
    const at = now()
    const id = newId()
    const record = recordOf(id, name, instruction, schedule, at)
    db.prepare(`INSERT INTO feed_sources
      (id, plugin_name, name, instruction, schedule, record, status, cwd, cursor, last_run_at, last_status, last_message, last_published_count, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL, 'idle', NULL, 0, 0, ?, ?)`)
      .run(id, pluginName, name, instruction, JSON.stringify(schedule), JSON.stringify(record), cwd, at, at)
    return get(id) as FeedSource
  }

  function update(id: string, changes: { name?: string, instruction?: string, schedule?: unknown, paused?: boolean }): FeedSource | null {
    const found = get(id)
    if (!found) return null
    const name = changes.name === undefined
      ? found.name
      : requireText(changes.name.trim() || found.pluginName, MAX_SOURCE_NAME_CHARS, 'name')
    const instruction = changes.instruction === undefined
      ? found.instruction
      : requireText(changes.instruction, MAX_SOURCE_INSTRUCTION_CHARS, 'instruction')
    const schedule = changes.schedule === undefined ? found.schedule : parseFeedSourceSchedule(changes.schedule)
    const status: FeedSourceStatus = changes.paused === undefined ? found.status : (changes.paused ? 'paused' : 'active')
    const at = now()
    const record = changes.schedule !== undefined
      ? recordOf(id, name, instruction, schedule, at)
      : { ...found.record, title: name, prompt: instruction }
    db.prepare(`UPDATE feed_sources
      SET name = ?, instruction = ?, schedule = ?, record = ?, status = ?, revision = ?, updated_at = ?
      WHERE id = ?`)
      .run(name, instruction, JSON.stringify(schedule), JSON.stringify(record), status, found.revision + 1, at, id)
    return get(id)
  }

  function setPaused(id: string, paused: boolean): FeedSource | null {
    const found = get(id)
    if (!found) return null
    const status: FeedSourceStatus = paused ? 'paused' : 'active'
    if (found.status === status) return found
    db.prepare('UPDATE feed_sources SET status = ?, revision = ?, updated_at = ? WHERE id = ?')
      .run(status, found.revision + 1, now(), id)
    return get(id)
  }

  function recordRun(id: string, outcome: {
    ranAt: number
    status: FeedSourceLastStatus
    message: string | null
    publishedCount: number
    cursor?: unknown
  }): FeedSource | null {
    const found = get(id)
    if (!found) return null
    const nextCursor = outcome.cursor !== undefined ? outcome.cursor : found.cursor
    db.prepare(`UPDATE feed_sources
      SET last_run_at = ?, last_status = ?, last_message = ?, last_published_count = ?, cursor = ?, updated_at = ?
      WHERE id = ?`)
      .run(outcome.ranAt, outcome.status, outcome.message, outcome.publishedCount, nextCursor === null ? null : JSON.stringify(nextCursor), now(), id)
    return get(id)
  }

  const remove = (id: string): boolean => Number(db.prepare('DELETE FROM feed_sources WHERE id = ?').run(id).changes) > 0

  const list = (): FeedSource[] => (db.prepare('SELECT * FROM feed_sources ORDER BY created_at DESC, rowid DESC').all() as Row[]).map(sourceOf)

  const nextDueAt = (): number | null => {
    const active = list().filter((source) => source.status === 'active')
    if (!active.length) return null
    return Math.min(...active.map((source) => Date.parse(source.record.scheduledAt)))
  }

  /**
   * Takes every active source due by now, advancing each recurring record to its next occurrence so
   * missed periods produce at most one latest occurrence.
   */
  function takeDue(): FeedSourceOccurrence[] {
    const at = now()
    return list()
      .filter((source) => source.status === 'active' && Date.parse(source.record.scheduledAt) <= at)
      .map((source) => {
        const { occurrenceAt, nextScheduledAt } = resolveRecurringOccurrence(source.record, at)
        if (nextScheduledAt) {
          db.prepare('UPDATE feed_sources SET record = ? WHERE id = ?')
            .run(JSON.stringify({ ...source.record, scheduledAt: nextScheduledAt }), source.id)
        } else {
          db.prepare("UPDATE feed_sources SET status = 'paused' WHERE id = ?").run(source.id)
        }
        return { key: `${source.id}@${occurrenceAt}`, at: occurrenceAt, source }
      })
  }

  return { create, update, setPaused, recordRun, remove, get, list, nextDueAt, takeDue }
}

export const FEED_SOURCE_WRITES = Object.freeze(['create', 'update', 'setPaused', 'remove'] as const)

export type FeedSourceStore = ReturnType<typeof openFeedSourceStore>
