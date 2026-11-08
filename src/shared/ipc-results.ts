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

/** A background task started (task-runtime.ts begin), or why not, in words for the user. */
export type TaskStartResult = { ok: true, task: TaskSummary } | { ok: false, problem: string }

/**
 * Where a task is as the window got it (task-runtime.ts): the run it is at, the last piece of its stream already in
 * what it was given, and how many times it had changed (its snapshots' `revision`). A piece of another run, or at or
 * below that piece, and a snapshot at or below that revision, are not the window's to take again.
 */
/**
 * What the conversation on screen waits on the user for (acp-bridge.ts sessionWaits): approvals, questions and keys
 * asked for, each as the window was first told of it (`permission`, `question`, `secret_request`).
 */
export interface SessionWaits {
  permissions: ReadonlyArray<{ requestId: string, toolCall: unknown, options: unknown }>
  questions: ReadonlyArray<{ questionId: string, questions: unknown }>
  secrets: ReadonlyArray<{ requestId: string, server: string, names: readonly string[] }>
}
export interface TaskMark { runId: string, seq: number, revision?: number }
/** A tool call a task's run has at work, as its registry knows it (task-registry.ts activeTools). */
export interface ActiveTool { toolCallId: string, title: string }

/** A task as `task:finished` gives it back: ended; at work in this launch (a reloaded window); or one Viva quit on. */
export type KeptTask = ({ mark?: TaskMark }) & (
  | { task: TaskSummary, status: string, endedAt: number, messages: readonly KeptMessage[] }
  | { task: TaskSummary, status: 'running' | 'waiting', endedAt: null, startedAt: number | null, messages: readonly KeptMessage[],
    waits: { permissions: readonly unknown[], questions: readonly unknown[] }, tools: readonly ActiveTool[] }
  | { task: TaskSummary, status: 'interrupted', endedAt: number, messages: readonly KeptMessage[] })

/**
 * What a run begins with, on the snapshot that starts it (the window makes the task, or its new run, from it): the
 * words it was given, and, for a task new, its summary and the session of the conversation its line goes in.
 */
export interface TaskOpening { words: string, task?: TaskSummary, hostSession?: string | null }

export interface IpcResults {
  'draft:get': import('./composer-draft.ts').DraftSnapshot
  'draft:append-image': void
  'draft:keep-images': void
  'draft:append-files': void
  'agent:info': import('./agent-info.ts').AgentInfo
  'agent:prompt': void
  'agent:steer': import('./agent-info.ts').SteerResult
  'agent:cancel': void
  'agent:new-session': import('./agent-info.ts').AgentInfo
  'agent:set-config': import('./agent-info.ts').AgentInfo
  'agent:permission': boolean
  'agent:answer': boolean
  'agent:secrets': boolean
  'schedules:accept': { title: string, nextAt: string }
  'schedules:decline': void
  'task:finished': KeptTask[]
  /** Said on the live channel (`waits`, a SessionWaits), in its place among the pushes. */
  'agent:waits': true
  'task:close': void
  'task:stop': void
}

export type TaskStatus = 'running' | 'waiting' | 'done' | 'stopped' | 'error' | 'interrupted'
export interface TaskSnapshot {
  taskId: string, runId: string, title: string, status: TaskStatus, currentAction: string | null,
  waitingFor: 'permission' | 'answer' | null, startedAt: number, updatedAt: number,
  endedAt: number | null, resultPreview: string, revision: number,
}
export type WindowSnapshot = TaskSnapshot & { taskSeq: number, opening?: TaskOpening }
