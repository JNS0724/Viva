import { t } from '../shared/i18n/translate.ts'
import { ended, updated, type Transcript } from './task-transcript.ts'

/**
 * One prompt run where nobody watches (a schedule's, system-design §12.2): in a fresh session of its own, at the level
 * the user picked, what it would ask refused since nobody is there (acp-bridge.ts startUnattendedTask); not one of
 * 后台's tasks. What it says is gathered here from dsh's
 * task events, which go nowhere else; its last answer is the result. The session is closed once it is over.
 */
export const RUN_TIMEOUT_MS = 10 * 60 * 1000

export type RunResult =
  | { ok: true, text: string }
  /** `unavailable`: dsh is not there now (not started, restarting); run it again once it is. */
  | { ok: false, problem: string, unavailable?: boolean }

export interface UnattendedAgent {
  startUnattendedTask: (where: { cwd: string }) => Promise<{ ok: boolean, reason?: string, taskId?: string }>
  promptTask: (taskId: string, text: string) => unknown
  closeTask: (taskId: string) => unknown
}

export interface TaskEvent { type: string, taskId: string, update?: unknown, stopReason?: unknown, message?: unknown }

interface Running { transcript: Transcript, finish: (result: RunResult) => void }

const UNAVAILABLE: RunResult = Object.freeze({ ok: false, problem: 'unavailable', unavailable: true })

/** The turn's last answer, when it ended as a turn should. */
function resultOf(transcript: Transcript, event: TaskEvent): RunResult {
  const last = ended(transcript, event.stopReason).at(-1)
  if (event.stopReason === 'end_turn' && last?.role === 'assistant' && last.text.trim()) return { ok: true, text: last.text.trim() }
  const problem = typeof event.message === 'string' && event.message ? event.message : last?.text ?? String(event.stopReason)
  return { ok: false, problem }
}

export function createUnattendedRuns({ agent, timeoutMs = RUN_TIMEOUT_MS, later = setTimeout, cancel = clearTimeout }: {
  /** The agent now; null while there is none. */
  agent: () => UnattendedAgent | null
  timeoutMs?: number
  later?: (run: () => void, ms: number) => unknown
  cancel?: (timer: never) => void
}) {
  let runs = new Map<string, Running>()

  /** Whether `taskId` is a run of these: its events are for `receive`, not for 后台. */
  const owns = (taskId: string): boolean => runs.has(taskId)

  function receive(event: TaskEvent): void {
    const running = runs.get(event.taskId)
    if (!running) return
    if (event.type === 'task_update') {
      runs = new Map([...runs, [event.taskId, { ...running, transcript: updated(running.transcript, event.update) }]])
      return
    }
    if (event.type === 'task_end') running.finish(resultOf(running.transcript, event))
  }

  /** `prompt` run in `cwd`, which the caller has checked is there. */
  async function run(prompt: string, cwd: string): Promise<RunResult> {
    const now = agent()
    if (!now) return UNAVAILABLE
    const started = await now.startUnattendedTask({ cwd })
    if (!started.ok || !started.taskId) return UNAVAILABLE
    const taskId = started.taskId
    const result = await new Promise<RunResult>((resolve) => {
      const finish = (value: RunResult) => {
        if (runs.get(taskId)?.finish !== finish) return
        cancel(timer as never)
        runs = new Map([...runs].filter(([id]) => id !== taskId))
        resolve(value)
      }
      const timer = later(() => finish({ ok: false, problem: t('main.unattended-runs.timed.out') }), timeoutMs)
      runs = new Map([...runs, [taskId, { transcript: [], finish }]])
      Promise.resolve(now.promptTask(taskId, prompt)).catch((err: unknown) => finish({ ok: false, problem: err instanceof Error ? err.message : String(err) }))
    })
    Promise.resolve(now.closeTask(taskId)).catch(() => {})
    return result
  }

  /** dsh went: the runs underway end unfinished, to be run again once it is back. */
  function gone(): void {
    for (const running of [...runs.values()]) running.finish(UNAVAILABLE)
  }

  return { owns, receive, run, gone }
}

export type UnattendedRuns = ReturnType<typeof createUnattendedRuns>
