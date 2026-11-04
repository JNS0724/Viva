import type { QuestionAnswer } from '../shared/question-answer.ts'
import { answered, ended, fromSaved, said, saved, updated, type SavedMessage, type Transcript } from './task-transcript.ts'

/**
 * What each background task says, kept by the backend as it comes (task-transcript.ts) and saved into its segment
 * of the history: every so often while it talks, at once when its turn ends, and when Viva quits or dsh goes
 * (`flush`). The window only shows it; nothing it does or misses changes what is kept.
 */

/** While a task talks, what it said is saved at most this often. */
export const SAVE_EVERY_MS = 10_000

/** How a turn's stop reason reads as the way a task ended. */
export const ENDED_STATUS: Readonly<Record<string, string>> = { end_turn: 'done', cancelled: 'stopped', error: 'error' }

/** A question a task asked, for wording its answer: which task, and the questions. */
interface Asked { taskId: string, questions: Array<{ id: string, question: string, header?: string }> }

export interface TaskWordsDeps {
  /** What the task has said, from its own words on, into its segment. */
  persist: (taskId: string, messages: SavedMessage[]) => void
  /** Its turn ended, how (done, stopped, error): kept to be asked again. */
  end: (taskId: string, status: string) => void
  later?: (run: () => void, ms: number) => unknown
  cancel?: (timer: unknown) => void
  everyMs?: number
  onError?: (err: Error) => void
}

type AgentEvent = Readonly<Record<string, unknown>>
const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** Answers as the question desk took them (question-channel.ts checkAnswers), kept to word the reply. */
function answersOf(value: unknown): QuestionAnswer[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): QuestionAnswer[] => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !Array.isArray(item.selected)) return []
    const selected = item.selected.filter((label: unknown): label is string => typeof label === 'string')
    return [{ id: item.id, selected, ...(typeof item.custom === 'string' && item.custom.trim() ? { custom: item.custom.trim() } : {}) }]
  })
}

function askedOf(event: AgentEvent): Asked | null {
  if (!Array.isArray(event.questions)) return null
  const questions = event.questions.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return []
    const { id, question, header } = item as Record<string, unknown>
    return typeof id === 'string' && typeof question === 'string' ? [{ id, question, ...(typeof header === 'string' ? { header } : {}) }] : []
  })
  return { taskId: text(event.taskId), questions }
}

export function createTaskWords({ persist, end, later = setTimeout, cancel = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  everyMs = SAVE_EVERY_MS, onError = () => {} }: TaskWordsDeps) {
  /** taskId → what it has said; only tasks this launch holds. */
  const transcripts = new Map<string, Transcript>()
  /** Tasks with a save waiting: one each, however much they say meanwhile. */
  const timers = new Map<string, unknown>()
  /** questionId → the task that asked it, while it waits. */
  const questions = new Map<string, Asked>()

  function save(taskId: string) {
    const timer = timers.get(taskId)
    if (timer !== undefined) cancel(timer)
    timers.delete(taskId)
    const transcript = transcripts.get(taskId)
    if (!transcript) return
    try {
      persist(taskId, saved(transcript))
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)))
    }
  }

  function soon(taskId: string) {
    if (timers.has(taskId)) return
    timers.set(taskId, later(() => { timers.delete(taskId); save(taskId) }, everyMs))
  }

  function change(taskId: string, next: Transcript) {
    if (next === transcripts.get(taskId)) return
    transcripts.set(taskId, next)
    soon(taskId)
  }

  /** A task this launch holds, from what it had said (none for a new one). */
  function track(taskId: string, before: ReadonlyArray<{ role?: unknown, text?: unknown }> = []) {
    transcripts.set(taskId, fromSaved(before))
  }

  /** The user said something to the task: its first words, words into its turn, its next question. */
  function userSaid(taskId: string, words: string) {
    const transcript = transcripts.get(taskId)
    if (transcript) change(taskId, said(transcript, words))
  }

  /** An event from the agent (acp-bridge.ts emit); those not about a task held are left alone. */
  function receive(raw: unknown) {
    if (!raw || typeof raw !== 'object') return
    const event = raw as AgentEvent
    const taskId = text(event.taskId)
    if (event.type === 'task_question') {
      const asked = askedOf(event)
      if (asked && text(event.questionId)) questions.set(text(event.questionId), asked)
    }
    if (event.type === 'task_question_closed') questions.delete(text(event.questionId))
    const transcript = transcripts.get(taskId)
    if (!transcript) return
    if (event.type === 'task_update') change(taskId, updated(transcript, event.update))
    if (event.type === 'task_end') {
      transcripts.set(taskId, ended(transcript, event.stopReason))
      save(taskId)
      end(taskId, ENDED_STATUS[text(event.stopReason)] ?? 'done')
    }
  }

  /**
   * About to answer a question: what was asked is taken now, because dsh closes the question (task_question_closed)
   * while it takes the answer. Returns how to keep the reply once dsh accepted it; null for a question of no task held.
   */
  function holdQuestion(questionId: string): ((raw: unknown) => void) | null {
    const asked = questions.get(questionId)
    if (!asked) return null
    return (raw) => {
      questions.delete(questionId)
      const transcript = transcripts.get(asked.taskId)
      if (transcript) change(asked.taskId, answered(transcript, asked.questions, answersOf(raw)))
    }
  }

  /** The user answered a question (accepted by dsh): the reply joins the task that asked it. */
  const answer = (questionId: string, raw: unknown) => holdQuestion(questionId)?.(raw)

  /** Everything waiting is saved now: Viva quits, or dsh went. */
  const flush = () => [...timers.keys()].forEach(save)

  /** The task is let go: saved as it is, then no longer held. */
  function drop(taskId: string) {
    save(taskId)
    transcripts.delete(taskId)
  }

  /** What a task held has said so far, as it would be saved, the answer being written marked open; null for one not held. */
  const current = (taskId: string) => {
    const transcript = transcripts.get(taskId)
    return transcript ? transcript.map(({ role, text, open, streamKey, blocks }) => ({
      role, text, ...(open ? { open: true } : {}), ...(open && streamKey ? { streamKey, blocks: blocks ?? [] } : {}),
    })) : null
  }

  return { track, userSaid, receive, answer, holdQuestion, flush, drop, current, has: (taskId: string) => transcripts.has(taskId) }
}
export type TaskWords = ReturnType<typeof createTaskWords>
