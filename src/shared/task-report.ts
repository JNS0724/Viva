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
/** A task's line in a note: its title and id. */
const TASK_LINE = /任务：「([^」\n]*)」（([^）\n]+)）/g

/** The note as the conversation keeps and shows it: without its token lines. */
export const shownNote = (note: string): string => note.split('\n').filter((line) => !line.startsWith(TOKEN_MARK)).join('\n')

/** What the record of a delivered note says on its line: the tasks it tells of, and whether it came into a turn. */
export interface ReportRecord { tasks: Array<{ title: string, taskId: string }>, inTurn: boolean }

/** A note read back, or null for text that is no task's result. */
export function reportRecordOf(text: string): ReportRecord | null {
  if (!text.startsWith(REPORT_HEAD)) return null
  const tasks = [...text.matchAll(TASK_LINE)].map(([, title, taskId]) => ({ title, taskId }))
  return tasks.length ? { tasks, inTurn: text.includes(IN_TURN_MARK) } : null
}
