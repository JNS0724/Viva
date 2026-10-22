/**
 * viva-trace: records what each turn did (thoughts, tool calls and their outcome) into trace.db, so the
 * app can show the 过程 of a reopened conversation without reading dsh's private session log format.
 * Loaded by the app's dsh profile (src/main/dsh-profile.js) with `config.file` = trace.db.
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { stepsFrom } from './lib/steps.ts'
import { openTraceDb } from './lib/store.ts'

export const name = 'viva-trace'
export const inject = ['agents']
export const Config = z.object({ file: z.string() })

const log = (message: string) => process.stderr.write(`[${name}] ${message}\n`)

/** The session's events of `turn`, oldest first (the turn is the latest one). */
function turnEvents(agent: Agent, turn: number) {
  const events: Array<NonNullable<ReturnType<Agent['session']['eventAt']>>> = []
  for (let seq = agent.session.seq - 1; seq >= 0; seq -= 1) {
    const event = agent.session.eventAt(SessionSeq(seq))
    if (event?.type === 'turn/start' && event.data.turn === turn) break
    if (event) events.push(event)
  }
  return events.reverse()
}

export function apply(ctx: Context, config: { file: string }) {
  if (!config?.file) throw new Error(`${name}: config.file (the trace.db path) is required`)
  const db = openTraceDb({ file: config.file })
  ctx.effect(() => () => db.close(), 'trace.db')

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    try {
      const steps = stepsFrom(turnEvents(agent, turn))
      if (steps.length) db.recordSteps(String(agent.session.id), steps)
    } catch (err) {
      // The trace is a convenience: failing to record it must never touch the turn.
      log(`could not record turn ${turn}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}
