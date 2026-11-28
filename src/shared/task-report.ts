import { stripLeadingProvenanceHeader } from './request-routing/provenance.ts'

/**
 * What the model replies, in a turn started by a background task's end (backend/task-reports.ts), when it has nothing
 * to add to what the task's line already says: the window then shows nothing for that turn (renderer/state.ts).
 */
export const SILENT_REPLY = '[silent]'

/** Whether an answer is the silent reply, give or take the space and punctuation a model may add around it. */
export const isSilentReply = (text: string): boolean => text.trim().replace(/[。.!！\s]+$/u, '') === SILENT_REPLY

/**
 * How a background task's result is worded for the model (backend/task-reports.ts noteFor), and read back for the
 * conversation's record of it (renderer/view/report-record.ts): one format, here, for both sides.
 */
export const REPORT_HEAD = '【后台任务结束】'
/** Said in a note put into a turn already running, rather than a turn of its own. */
export const IN_TURN_MARK = '它在你这一轮工作时到达'
/** The line that carries a report's token (plugins/steer/lib/reports.ts): a secret the window never shows. */
export const TOKEN_MARK = '回报凭据：'
/** The report of one run of a task (backend/task-reports.ts, effects key) and the record kept of it (report-records.ts). */
export const reportId = (taskId: string, runId: string): string => `${taskId}:${runId}`
/** Synthetic taskId namespace used when reporting a completed unattended schedule run back to the main conversation. */
export const SCHEDULE_TASK_PREFIX = 'schedule:'
export const scheduleTaskId = (scheduleId: string): string => `${SCHEDULE_TASK_PREFIX}${scheduleId}`
export const scheduleIdOfTask = (taskId: string): string | null =>
  taskId.startsWith(SCHEDULE_TASK_PREFIX) ? taskId.slice(SCHEDULE_TASK_PREFIX.length) || null : null
export const isScheduleTaskId = (taskId: string): boolean => scheduleIdOfTask(taskId) !== null

/** A task's line in a note: its title and id. */
const TASK_LINE = /^任务：「([^\n]+)」\（([^）\n]+)）$/gm
/**
 * What a task asked and said goes in a note between these tags, as data: whatever is inside is the task's, never the
 * note's own lines. A tag inside the data is broken with a zero-width space (asData), so it cannot end its block early.
 */
export const asData = (text: string): string => text.replace(/<(\/?)(task-request|task-output)>/g, '<\u200B$1$2>')

function findNextDataBlock(note: string, from: number): { start: number, end: number } | null {
  let search = from
  while (search < note.length) {
    const idx = note.indexOf('<task-', search)
    if (idx < 0) return null
    const openTag = note.startsWith('<task-output>', idx)
      ? '<task-output>'
      : note.startsWith('<task-request>', idx)
        ? '<task-request>'
        : null
    if (!openTag) {
      search = idx + 6
      continue
    }
    const closeTag = `</${openTag.slice(1)}`
    const closeIdx = note.indexOf(closeTag, idx + openTag.length)
    if (closeIdx < 0) {
      search = idx + openTag.length
      continue
    }
    return { start: idx, end: closeIdx + closeTag.length }
  }
  return null
}

/** The note's own lines: its task lines and marks, without what the tasks asked and said. */
function ownLines(note: string): string {
  let pos = 0
  let out = ''
  while (pos < note.length) {
    const block = findNextDataBlock(note, pos)
    if (!block) return pos === 0 ? note : out + note.slice(pos)
    out += note.slice(pos, block.start)
    pos = block.end
  }
  return out
}

const stripOwnTokenLines = (chunk: string): string => chunk.split('\n').filter((line) => !line.startsWith(TOKEN_MARK)).join('\n')

/** The note as the conversation keeps and shows it: without its own token lines, leaving `<task-request>` and `<task-output>` untouched. */
export function shownNote(note: string): string {
  if (!note.includes(TOKEN_MARK)) return note
  let last = 0
  let out = ''
  while (last < note.length) {
    const block = findNextDataBlock(note, last)
    if (!block) return out + stripOwnTokenLines(note.slice(last))
    out += stripOwnTokenLines(note.slice(last, block.start)) + note.slice(block.start, block.end)
    last = block.end
  }
  return out
}

/** What the record of a delivered note says on its line: the tasks it tells of, and whether it came into a turn. */
export interface ReportRecord { tasks: Array<{ title: string, taskId: string }>, inTurn: boolean }

/** A note read back, or null for text that is no task's result. */
export function reportRecordOf(text: string): ReportRecord | null {
  const body = stripLeadingProvenanceHeader(text)
  if (!body.startsWith(REPORT_HEAD)) return null
  const own = ownLines(body)
  const tasks = [...own.matchAll(TASK_LINE)].map(([, title, taskId]) => ({ title, taskId }))
  return tasks.length ? { tasks, inTurn: own.includes(IN_TURN_MARK) } : null
}
