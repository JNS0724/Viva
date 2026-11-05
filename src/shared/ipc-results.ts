/**
 * What the main process answers on a channel (ipc-contract.ts says what may be sent), for the channels whose answer
 * is written out so far: the background tasks' (task-runtime.ts). The backend's handlers return these types and the
 * window's bridge (renderer/globals.d.ts Invoke) reads them; a channel not listed still answers `any`.
 */

/** A background task as the window knows it: its id, its segment in the history, its title and the words it was given. */
export interface TaskSummary {
  id: string
  segmentId: string
  title: string
  words: string
  /** Where its line sits in the conversation it was started from, for a task kept from an earlier launch. */
  host?: { conversationId: string, at: number, order: number }
}

/** What a task said, as kept in its segment (history-db.ts): a message by its role and words. */
export interface KeptMessage { role: string, text: string, [field: string]: unknown }

/** 后台做: started, or why not, in words for the user. */
export type TaskStartResult = { ok: true, task: TaskSummary } | { ok: false, problem: string }

/** A task as `task:finished` gives it back: ended; at work in this launch (a reloaded window); or one Viva quit on. */
export type KeptTask =
  | { task: TaskSummary, status: string, endedAt: number, messages: readonly KeptMessage[] }
  | { task: TaskSummary, status: 'running', endedAt: null, startedAt: number | null, messages: readonly KeptMessage[],
    waits: { permissions: readonly unknown[], questions: readonly unknown[] } }
  | { task: TaskSummary, status: 'interrupted', endedAt: number, messages: readonly KeptMessage[] }

export interface IpcResults {
  'task:start': TaskStartResult
  'task:finished': KeptTask[]
  'task:close': void
  'task:stop': void
}
