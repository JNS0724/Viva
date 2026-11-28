import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { scheduleTaskId } from '../shared/task-report.ts'
import { transaction } from './app-db.ts'
import type { Effects } from './effects.ts'
import type { Apply } from './journal.ts'
import { boundScheduleRecordOutput, GATHER_MS, REPORT, reportId, type ReportPayload } from './task-reports.ts'

/** How much of a scheduled run's answer a notification shows. */
export const NOTICE_BODY_CHARS = 200
/** The effects queue's kind for a completed schedule run's notification. */
export const SCHEDULE_NOTICE = 'schedule-notice'
/** Legacy effects kind from before 动态 was removed. */
export const LEGACY_FEED_NOTICE = 'feed-notice'

const LEGACY_TABLES = Object.freeze(['feed_items', 'feed_sources', 'feed_source_runs'] as const)

type Row = Record<string, unknown>

function parseScheduleId(key: string, originRaw: unknown): string {
  if (typeof originRaw === 'string' && originRaw) {
    try {
      const parsed = JSON.parse(originRaw) as { ref?: unknown }
      if (typeof parsed?.ref === 'string' && parsed.ref.trim()) return parsed.ref.trim()
    } catch { /* fall back to occurrence key */ }
  }
  const prefix = key.split('@')[0]?.trim()
  return prefix || 'legacy'
}

function statusOfLegacyBody(body: string): 'done' | 'error' {
  return body.startsWith('这次定时任务试了几次都没做成：')
    || body.startsWith('This scheduled run did not finish after several tries: ')
    ? 'error'
    : 'done'
}

/**
 * One-time, idempotent upgrade from builds that stored schedule results in `feed_items` + `feed-notice`:
 * unread `source = 'schedule'` items become `report` effects for the main conversation (and `schedule-notice` if their
 * `feed-notice` was still pending); seen items and non-schedule plugin feed items are not injected into the main
 * conversation; legacy `feed-notice` effects are cancelled through `Effects` and only the retired `feed_*` tables are
 * dropped directly in the same transaction.
 */
export function migrateLegacyFeed({ db, apply, effects, scheduleCwd = () => null, hasRecord = () => false, now = Date.now }: {
  db: DatabaseSync
  apply?: Apply
  effects: Pick<Effects, 'get' | 'hasKind' | 'queue' | 'cancelStarting'>
  scheduleCwd?: (scheduleId: string) => string | null
  hasRecord?: (reportKey: string) => boolean
  now?: () => number
}): { migratedReports: number, migratedNotices: number, droppedTables: string[] } {
  const existingTables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('feed_items', 'feed_sources', 'feed_source_runs')").all() as Array<{ name: string }>)
      .map((row) => row.name),
  )
  const legacyTables = LEGACY_TABLES.filter((name) => existingTables.has(name))
  const hasLegacyNotices = effects.hasKind(LEGACY_FEED_NOTICE)
  if (legacyTables.length === 0 && !hasLegacyNotices) {
    return { migratedReports: 0, migratedNotices: 0, droppedTables: [] }
  }
  const change: Apply = apply ?? ((_kind, _data, write) => ({ value: transaction(db, write) }))
  return change('feed.migrated', { tables: legacyTables }, () => {
    let migratedReports = 0
    let migratedNotices = 0
    if (existingTables.has('feed_items')) {
      const unread = db.prepare(
        "SELECT id, key, title, body, origin, created_at FROM feed_items WHERE source = 'schedule' AND seen_at IS NULL ORDER BY created_at ASC, rowid ASC",
      ).all() as Row[]
      for (const row of unread) {
        const id = String(row.id)
        const key = String(row.key)
        const title = String(row.title)
        const body = String(row.body)
        const scheduleId = parseScheduleId(key, row.origin)
        const taskId = scheduleTaskId(scheduleId)
        const reportKey = reportId(taskId, key)
        if (!hasRecord(reportKey) && !effects.get(REPORT, reportKey)) {
          const createdAt = Number(row.created_at)
          const bounded = boundScheduleRecordOutput(body)
          const payload: ReportPayload = {
            taskId,
            runId: key,
            title,
            status: statusOfLegacyBody(body),
            host: null,
            cwd: scheduleCwd(scheduleId),
            output: bounded.text,
            ...(bounded.truncated ? { outputTruncated: true } : {}),
            token: randomUUID().replaceAll('-', ''),
            request: '',
            topic: null,
            startedAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : null,
            by: 'schedule',
          }
          effects.queue(REPORT, reportKey, payload, now() + GATHER_MS)
          migratedReports += 1
        }
        const noticeKey = `${scheduleId}:${key}`
        if (effects.get(LEGACY_FEED_NOTICE, id) && !effects.get(SCHEDULE_NOTICE, noticeKey)) {
          effects.queue(SCHEDULE_NOTICE, noticeKey, { title, body: body.slice(0, NOTICE_BODY_CHARS) })
          migratedNotices += 1
        }
      }
    }
    if (hasLegacyNotices) {
      effects.cancelStarting(LEGACY_FEED_NOTICE, '')
    }
    for (const table of legacyTables) {
      db.exec(`DROP TABLE IF EXISTS ${table}`)
    }
    return { migratedReports, migratedNotices, droppedTables: [...legacyTables] }
  }).value
}
