/**
 * What the model replies, in a turn started by a background task's end (backend/task-reports.ts), when it has nothing
 * to add to what the task's line already says: the window then shows nothing for that turn (renderer/state.ts).
 */
export const SILENT_REPLY = '[silent]'

/** Whether an answer is the silent reply, give or take the space and punctuation a model may add around it. */
export const isSilentReply = (text: string): boolean => text.trim().replace(/[。.!！\s]+$/u, '') === SILENT_REPLY
