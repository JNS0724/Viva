import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { t } from '../shared/i18n/translate.ts'
import { scheduleTaskId } from '../shared/task-report.ts'
import { transaction } from './app-db.ts'
import type { Effects } from './effects.ts'
import { openHistoryDb } from './history-db.ts'
import type { Apply } from './journal.ts'
import { boundScheduleRecordOutput, GATHER_MS, recordedNote, REPORT, reportId, type ReportPayload } from './task-reports.ts'

/** How much of a scheduled run's answer a notification shows. */
export const NOTICE_BODY_CHARS = 200
/** The effects queue's kind for a completed schedule run's notification. */
export const SCHEDULE_NOTICE = 'schedule-notice'
/** Legacy effects kind from before 动态 was removed. */
export const LEGACY_FEED_NOTICE = 'feed-notice'

const LEGACY_TABLES = Object.freeze(['feed_items', 'feed_sources', 'feed_source_runs'] as const)

type Row = Record<string, unknown>

export interface LegacyArchiveItem {
  key: string
  title: string
  sourceLabel: string
  body: string
  at: number
}

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

function parseOriginLabel(originRaw: unknown, fallback: string): string {
  if (typeof originRaw === 'string' && originRaw) {
    try {
      const parsed = JSON.parse(originRaw) as { label?: unknown }
      if (typeof parsed?.label === 'string' && parsed.label.trim()) return parsed.label.trim()
    } catch { /* fall back to source */ }
  }
  return fallback
}

function sanitizeLegacyBody(body: string): string {
  return body
    .replace(/这个定时要读的文件夹 [^\n]+ 已经不在了。/g, t('main.schedule-runs.folder.gone'))
    .replace(/The folder this schedule reads, [^\n]+, is no longer there\./g, 'The original working folder for this scheduled task is no longer there.')
}

function statusOfLegacyBody(body: string): 'done' | 'error' {
  return body.startsWith('这次定时任务试了几次都没做成：')
    || body.startsWith('This scheduled run did not finish after several tries: ')
    ? 'error'
    : 'done'
}

/**
 * One-time, idempotent upgrade from builds that stored schedule and plugin results in `feed_items` + `feed-notice`:
 * - unread `source = 'schedule'` items become `report` effects for the main conversation (and `schedule-notice` if
 *   their `feed-notice` was still pending);
 * - seen `source = 'schedule'` items attach as `report_records` to their originating conversation when still present,
 *   and otherwise join legacy plugin items in the read-only `legacy-feed-archive` topic so no historical text is lost;
 * - legacy `feed-notice` effects are cancelled through `Effects` and retired `feed_*` tables are dropped atomically.
 */
export function migrateLegacyFeed({
  db,
  apply,
  effects,
  scheduleCwd = () => null,
  scheduleConversationId = () => null,
  hasRecord = () => false,
  hasConversation,
  addRecord,
  archiveItems,
  now = Date.now,
}: {
  db: DatabaseSync
  apply?: Apply
  effects: Pick<Effects, 'get' | 'hasKind' | 'queue' | 'cancelStarting'>
  scheduleCwd?: (scheduleId: string) => string | null
  scheduleConversationId?: (scheduleId: string) => string | null
  hasRecord?: (reportKey: string) => boolean
  hasConversation?: (conversationId: string) => boolean
  addRecord?: (record: { conversationId: string, reportId: string, at: number, text: string }) => boolean
  archiveItems?: (items: readonly LegacyArchiveItem[]) => string | null
  now?: () => number
}): { migratedReports: number, migratedNotices: number, archivedItems: number, droppedTables: string[] } {
  const existingTables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('feed_items', 'feed_sources', 'feed_source_runs')").all() as Array<{ name: string }>)
      .map((row) => row.name),
  )
  const legacyTables = LEGACY_TABLES.filter((name) => existingTables.has(name))
  const hasLegacyNotices = effects.hasKind(LEGACY_FEED_NOTICE)
  if (legacyTables.length === 0 && !hasLegacyNotices) {
    return { migratedReports: 0, migratedNotices: 0, archivedItems: 0, droppedTables: [] }
  }
  const change: Apply = apply ?? ((_kind, _data, write) => ({ value: transaction(db, write) }))
  return change('feed.migrated', { tables: legacyTables }, () => {
    let migratedReports = 0
    let migratedNotices = 0
    let archivedItems = 0
    if (existingTables.has('feed_items')) {
      let fallbackHistory: ReturnType<typeof openHistoryDb> | null = null
      const ensureFallbackHistory = () => {
        fallbackHistory ??= openHistoryDb({ db, now })
        return fallbackHistory
      }
      const checkConversation = hasConversation ?? ((id: string) => ensureFallbackHistory().hasConversation(id))
      const writeRecord = addRecord ?? ((record: { conversationId: string, reportId: string, at: number, text: string }) => ensureFallbackHistory().addRecord(record))
      const writeArchive = archiveItems ?? ((items: readonly LegacyArchiveItem[]) => ensureFallbackHistory().archiveLegacyFeed(items))

      const allItems = db.prepare(
        'SELECT id, source, key, title, body, origin, created_at, seen_at FROM feed_items ORDER BY created_at ASC, rowid ASC',
      ).all() as Row[]
      const toArchive: LegacyArchiveItem[] = []
      for (const row of allItems) {
        const id = String(row.id)
        const source = String(row.source)
        const key = String(row.key)
        const title = String(row.title)
        const body = sanitizeLegacyBody(String(row.body))
        const createdAt = Number(row.created_at)
        const at = Number.isFinite(createdAt) && createdAt > 0 ? Math.trunc(createdAt) : now()
        const isUnreadSchedule = source === 'schedule' && (row.seen_at === null || row.seen_at === undefined)
        if (isUnreadSchedule) {
          const scheduleId = parseScheduleId(key, row.origin)
          const taskId = scheduleTaskId(scheduleId)
          const reportKey = reportId(taskId, key)
          if (!hasRecord(reportKey) && !effects.get(REPORT, reportKey)) {
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
              startedAt: at,
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
          continue
        }
        if (source === 'schedule') {
          const scheduleId = parseScheduleId(key, row.origin)
          const taskId = scheduleTaskId(scheduleId)
          const reportKey = reportId(taskId, key)
          const convId = scheduleConversationId(scheduleId)
          if (convId && checkConversation(convId)) {
            if (!hasRecord(reportKey)) {
              const bounded = boundScheduleRecordOutput(body)
              const payload: ReportPayload = {
                taskId,
                runId: key,
                title,
                status: statusOfLegacyBody(body),
                host: null,
                output: bounded.text,
                ...(bounded.truncated ? { outputTruncated: true } : {}),
                request: '',
                topic: null,
                startedAt: at,
                by: 'schedule',
              }
              if (writeRecord({ conversationId: convId, reportId: reportKey, at, text: recordedNote(payload) })) {
                archivedItems += 1
              }
            }
            continue
          }
        }
        const bounded = boundScheduleRecordOutput(body)
        toArchive.push({
          key: `${source}:${key}`,
          title,
          sourceLabel: parseOriginLabel(row.origin, source === 'schedule' ? '定时' : source),
          body: bounded.text,
          at,
        })
      }
      if (toArchive.length > 0) {
        writeArchive(toArchive)
        archivedItems += toArchive.length
      }
    }
    if (hasLegacyNotices) {
      effects.cancelStarting(LEGACY_FEED_NOTICE, '')
    }
    for (const table of legacyTables) {
      db.exec(`DROP TABLE IF EXISTS ${table}`)
    }
    return { migratedReports, migratedNotices, archivedItems, droppedTables: [...legacyTables] }
  }).value
}
