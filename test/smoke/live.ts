import fs from 'node:fs'
import path from 'node:path'
import { agentReady, clip, closeHub, escape, makeContext, type LiveContext, type LiveScenario } from './live-kit.ts'
import { APP_SCENARIOS } from './live-scenarios-app.ts'
import { CHAT_SCENARIOS } from './live-scenarios-chat.ts'
import { FOLLOWUP_SCENARIOS } from './live-scenarios-followups.ts'
import { MEMORY_SCENARIOS } from './live-scenarios-memory.ts'
import { SOURCE_SCENARIOS } from './live-scenarios-sources.ts'
import { report, run, until, type SmokeHooks, type SmokeWindow } from './smoke-kit.ts'

/**
 * The live check (docs/live-check.md): the app as users get it, on the real model, through every feature in
 * docs/features.md that depends on what the model does. Run by scripts/live.ts as two launches on one profile:
 * `live` runs the scenarios, `live-resume` what needs the app started again. Each scenario runs LIVE_REPEAT
 * times (3 by default) and passes only if every attempt does; LIVE_SET=core runs the ones marked core, LIVE_ONLY
 * the ids it lists. Each launch writes smoke/live/report-<phase>.json, which scripts/live.ts puts together.
 */
export const LIVE_SCENARIOS: readonly LiveScenario[] = [...CHAT_SCENARIOS, ...MEMORY_SCENARIOS, ...FOLLOWUP_SCENARIOS, ...SOURCE_SCENARIOS, ...APP_SCENARIOS]

const DEFAULT_REPEAT = 3
const MAX_REPEAT = 10
/** One attempt, however many turns it takes, is given up after this. */
const ATTEMPT_MS = 15 * 60_000
const RECOVER_MS = 60_000

export interface Attempt { ok: boolean, ms: number, failures: string[], shots: string[] }
export interface ScenarioResult { id: string, title: string, feature: string, core: boolean, step: 'run' | 'prepare', attempts: Attempt[] }
export interface PhaseReport { phase: string, set: string, repeat: number, startedAt: string, endedAt: string, scenarios: ScenarioResult[] }

/** The scenarios asked for: LIVE_ONLY's ids, else LIVE_SET's (core or full). */
export function selectScenarios(env: NodeJS.ProcessEnv, all: readonly LiveScenario[] = LIVE_SCENARIOS): LiveScenario[] {
  const only = (env.LIVE_ONLY ?? '').split(',').map((id) => id.trim()).filter(Boolean)
  if (only.length) {
    const unknown = only.filter((id) => !all.some((scenario) => scenario.id === id))
    if (unknown.length) throw new Error(`LIVE_ONLY names no such scenario: ${unknown.join(', ')}`)
    return all.filter((scenario) => only.includes(scenario.id))
  }
  const set = env.LIVE_SET ?? 'full'
  if (set !== 'core' && set !== 'full') throw new Error(`LIVE_SET is core or full, not ${set}`)
  return set === 'core' ? all.filter((scenario) => scenario.core) : [...all]
}

export function repeatOf(env: NodeJS.ProcessEnv): number {
  const repeat = Number(env.LIVE_REPEAT ?? DEFAULT_REPEAT)
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) throw new Error(`LIVE_REPEAT is a whole number from 1 to ${MAX_REPEAT}, not ${env.LIVE_REPEAT}`)
  return repeat
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 60_000)} min`)), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** After an attempt that stopped half-way: pages closed, a turn still going stopped, so the next starts clean. */
async function recover(win: SmokeWindow) {
  await escape(win)
  await closeHub(win)
  const busy = await run(win, `document.getElementById('send-btn').dataset.busy === 'true'`)
  if (busy) {
    // The send button stops the turn when the input is empty.
    await run(win, `(() => { const input = document.getElementById('composer-input'); input.value = ''; input.dispatchEvent(new Event('input')); document.getElementById('send-btn').click() })()`)
  }
  await until(win, `document.getElementById('send-btn').dataset.busy === 'false'`, 'the turn stopping', RECOVER_MS).catch(() => {})
}

type Base = Omit<LiveContext, 'expect' | 'shot' | 'tag' | 'code' | 'outDir' | 'attempt'>

async function attempt(base: Base, scenario: LiveScenario, step: 'run' | 'prepare', n: number): Promise<Attempt> {
  const failures: string[] = []
  const shots: string[] = []
  const outDir = path.join(base.liveDir, scenario.id, `${step}-${n}`)
  fs.mkdirSync(outDir, { recursive: true })
  const ctx = makeContext({ ...base, outDir, attempt: n }, failures, shots)
  const started = Date.now()
  const body = step === 'prepare' ? scenario.prepare : scenario.run
  try {
    if (!body) throw new Error(`${scenario.id} has no ${step}`)
    await withTimeout(body(ctx), ATTEMPT_MS, `${scenario.id} attempt ${n}`)
  } catch (err) {
    failures.push(`stopped: ${err instanceof Error ? err.message : String(err)}`)
    await ctx.shot('stopped').catch(() => {})
  }
  // A successful denial can legitimately be followed by a new clarification. It must not leave the
  // foreground turn busy and make the next attempt time out waiting for 新话题. Clean every attempt.
  await recover(base.win).catch(err => failures.push(`cleanup: ${err instanceof Error ? err.message : String(err)}`))
  return { ok: failures.length === 0, ms: Date.now() - started, failures, shots }
}

async function runAll(base: Base, scenarios: readonly LiveScenario[], step: 'run' | 'prepare', repeat: number): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = []
  for (const scenario of scenarios) {
    const attempts: Attempt[] = []
    for (let n = 1; n <= repeat; n += 1) {
      const result = await attempt(base, scenario, step, n)
      attempts.push(result)
      report(`live ${scenario.id} ${step} ${n}/${repeat}: ${result.ok ? 'ok' : `FAILED: ${clip(result.failures.join(' | '), 300)}`} (${Math.round(result.ms / 1000)} s)`)
    }
    results.push({ id: scenario.id, title: scenario.title, feature: scenario.feature, core: Boolean(scenario.core), step, attempts })
  }
  return results
}

/**
 * Runs the phase's scenarios and writes its report. @returns one line per scenario that did not pass every
 * attempt, for the smoke run to report as problems
 */
export async function runLive(win: SmokeWindow, smokeOut: string, phase: string, hooks: SmokeHooks): Promise<string[]> {
  const liveDir = path.join(smokeOut, 'live')
  fs.mkdirSync(liveDir, { recursive: true })
  const scenarios = selectScenarios(process.env)
  const repeat = repeatOf(process.env)
  const startedAt = new Date().toISOString()
  await agentReady(win)
  const base: Base = { win, hooks, liveDir, workspace: hooks.cwd, userData: hooks.userData }
  const twoLaunches = scenarios.filter((scenario) => scenario.prepare)
  const results = phase === 'live'
    ? [...await runAll(base, scenarios.filter((scenario) => !scenario.prepare), 'run', repeat), ...await runAll(base, twoLaunches, 'prepare', repeat)]
    : await runAll(base, twoLaunches, 'run', repeat)
  const phaseReport: PhaseReport = { phase, set: process.env.LIVE_ONLY ? `only ${process.env.LIVE_ONLY}` : process.env.LIVE_SET ?? 'full', repeat, startedAt, endedAt: new Date().toISOString(), scenarios: results }
  fs.writeFileSync(path.join(liveDir, `report-${phase}.json`), JSON.stringify(phaseReport, null, 2))
  return results
    .filter((result) => result.attempts.some((a) => !a.ok))
    .map((result) => `live ${result.id} (${result.step}): ${result.attempts.filter((a) => a.ok).length}/${result.attempts.length} attempts passed`)
}
