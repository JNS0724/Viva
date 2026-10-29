import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkConfigValues, missingFields } from './source-contract.ts'
import { readManifest, type SourceFolder } from './source-folders.ts'
import { checkSource, commandFor, pollSource, type RunOptions } from './source-run.ts'

/**
 * The checker for people writing a source (`npx viva-source test <folder>`, packages/viva-source-kit): runs a
 * folder the way the app does, with the app's own checks, and says what would go wrong once it is installed.
 * The manifest, how it starts on this platform, the config, `check`, then two polls: the second from the first's
 * cursor, which must not hand back the same messages. Built into the kit from these sources (build-source-kit).
 */
export type StepStatus = 'ok' | 'warn' | 'fail'
export interface CheckStep { status: StepStatus, title: string, detail?: string }
export interface FolderReport { ok: boolean, steps: CheckStep[] }

/** Programs missing or named otherwise on Windows; a source that runs one should say what to run there. */
let OTHER_ON_WINDOWS: Readonly<Record<string, string>> = { python3: '["py", "-3", …]', bash: t("main.source-check.bash.is.not.available.on.windows"), sh: t("main.source-check.sh.is.not.available.on.windows") }
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000

const step = (status: StepStatus, title: string, detail?: string): CheckStep => (detail === undefined ? { status, title } : { status, title, detail })

/** The steps of one poll's answer: how many, and what would be dropped or kept once. */
function batchSteps(label: string, messages: ReadonlyArray<{ id: string, at: number }>, dropped: readonly string[], now: number): CheckStep[] {
  const steps = [step('ok', t("main.source-check.returned.messages", { label: label, length: messages.length }))]
  for (const line of dropped) steps.push(step('warn', t("main.source-check.some.malformed.messages.will.be.discarded"), line))
  const ids = messages.map((m) => m.id)
  const twice = ids.find((id, i) => ids.indexOf(id) !== i)
  if (twice !== undefined) steps.push(step('warn', t("main.source-check.duplicate.ids.in.one.batch.only.one"), twice))
  const future = messages.find((m) => m.at > now + FUTURE_SLACK_MS)
  if (future) steps.push(step('warn', t("main.source-check.some.messages.are.dated.in.the.future"), future.id))
  return steps
}

/** check, then two polls, each step added to `steps`; stops at the first that fails. */
async function runSteps(folder: SourceFolder, config: Readonly<Record<string, string | number | boolean>>, options: RunOptions, now: number, steps: CheckStep[]) {
  const health = await checkSource(folder, config, options)
  if (!health.ok) return steps.push(step('fail', t("main.source-check.check.failed"), health.problem))
  steps.push(health.value.ok ? step('ok', t("main.source-check.check.connection.successful")) : step('warn', t("main.source-check.check.reported.a.connection.failure"), health.value.problem))

  const first = await pollSource(folder, config, null, options)
  if (!first.ok) return steps.push(step('fail', t("main.source-check.first.poll.failed"), first.problem))
  steps.push(...batchSteps(t("main.source-check.first.poll.from.the.start"), first.value.messages, first.value.dropped, now))
  if (first.value.cursor === null) steps.push(step('warn', t("main.source-check.no.cursor.returned"), t("main.source-check.each.fetch.restarts.from.the.beginning.duplicate")))

  const second = await pollSource(folder, config, first.value.cursor, options)
  if (!second.ok) return steps.push(step('fail', t("main.source-check.second.poll.failed"), second.problem))
  steps.push(...batchSteps(t("main.source-check.second.poll.continuing.from.the.previous.cursor"), second.value.messages, second.value.dropped, now))
  const seen = new Set(first.value.messages.map((m) => m.id))
  const again = second.value.messages.find((m) => seen.has(m.id))
  if (again && first.value.cursor !== null) steps.push(step('warn', t("main.source-check.the.second.poll.repeated.messages.from.the"), again.id))
  return steps.length
}

/** Runs the whole check; `values` are the config as the user would fill it in. */
export async function checkFolder(dir: string, { values = {}, run = {}, now = Date.now() }: {
  values?: Readonly<Record<string, unknown>>
  run?: Partial<RunOptions>
  now?: number
} = {}): Promise<FolderReport> {
  const steps: CheckStep[] = []
  const report = (): FolderReport => ({ ok: !steps.some((s) => s.status === 'fail'), steps })
  const read = readManifest(dir)
  if ('problem' in read) return { ok: false, steps: [step('fail', 'viva-source.json', read.problem)] }
  const { manifest } = read
  const folder: SourceFolder = { dir: path.resolve(dir), manifest }
  steps.push(step('ok', t("main.source-check.viva.source.json.fetch.every.minutes", { name: manifest.name, id: manifest.id, everyMinutes: manifest.everyMinutes })))

  const checked = checkConfigValues(manifest.config, values)
  if (checked.problem !== undefined) {
    steps.push(step('fail', t("main.source-check.invalid.configuration"), checked.problem))
    return report()
  }
  const missing = missingFields(manifest.config, checked.values)
  if (missing.length) {
    steps.push(step('fail', t("main.source-check.missing.required.configuration"), t("main.source-check.provide.config.file.or.set.name.value", { value1: missing.join('、') })))
    return report()
  }

  const dataDir = run.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'viva-source-check-'))
  const options: RunOptions = { ...run, dataDir }
  try {
    const started = commandFor(folder, options)
    if (!started.ok) {
      steps.push(step('fail', t("main.source-check.cannot.start"), started.problem))
      return report()
    }
    steps.push(step('ok', t("main.source-check.starts.successfully", { command: started.value.command, value2: started.value.args.join(' ') }).trim()))
    const other = OTHER_ON_WINDOWS[manifest.run[0]]
    if (other && !manifest.runOn?.win32) steps.push(step('warn', t("main.source-check.is.unavailable.on.windows", { value1: manifest.run[0] }), t("main.source-check.add.runon.for.example", { other: other })))
    await runSteps(folder, checked.values, options, now, steps)
    return report()
  } finally {
    if (!run.dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

const MARK: Readonly<Record<StepStatus, string>> = { ok: '✔', warn: '⚠', fail: '✖' }

/** The report as lines for a terminal. */
export function reportLines(report: FolderReport): string[] {
  const lines = report.steps.map((s) => `${MARK[s.status]} ${s.title}${s.detail ? `\n    ${s.detail}` : ''}`)
  const warnings = report.steps.filter((s) => s.status === 'warn').length
  lines.push(report.ok ? t("main.source-check.ready.to.install", { value1: warnings ? t("main.source-check.warnings", { warnings: warnings }) : '' }) : t("main.source-check.not.ready.to.install.resolve.the.issues"))
  return lines
}

onLocaleChange(() => {
  OTHER_ON_WINDOWS = { python3: '["py", "-3", …]', bash: t("main.source-check.bash.is.not.available.on.windows"), sh: t("main.source-check.sh.is.not.available.on.windows") }
})
