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
const OTHER_ON_WINDOWS: Readonly<Record<string, string>> = { python3: '["py", "-3", …]', bash: '（Windows 上没有 bash）', sh: '（Windows 上没有 sh）' }
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000

const step = (status: StepStatus, title: string, detail?: string): CheckStep => (detail === undefined ? { status, title } : { status, title, detail })

/** The steps of one poll's answer: how many, and what would be dropped or kept once. */
function batchSteps(label: string, messages: ReadonlyArray<{ id: string, at: number }>, dropped: readonly string[], now: number): CheckStep[] {
  const steps = [step('ok', `${label}：交回 ${messages.length} 条消息`)]
  for (const line of dropped) steps.push(step('warn', '有消息格式不对，会被丢掉', line))
  const ids = messages.map((m) => m.id)
  const twice = ids.find((id, i) => ids.indexOf(id) !== i)
  if (twice !== undefined) steps.push(step('warn', '同一批里有重复的 id，只会收一条', twice))
  const future = messages.find((m) => m.at > now + FUTURE_SLACK_MS)
  if (future) steps.push(step('warn', '有消息的时间在将来，at 是不是用了秒而不是毫秒？', future.id))
  return steps
}

/** check, then two polls, each step added to `steps`; stops at the first that fails. */
async function runSteps(folder: SourceFolder, config: Readonly<Record<string, string | number | boolean>>, options: RunOptions, now: number, steps: CheckStep[]) {
  const health = await checkSource(folder, config, options)
  if (!health.ok) return steps.push(step('fail', 'check 出错', health.problem))
  steps.push(health.value.ok ? step('ok', 'check：连接正常') : step('warn', 'check 说连不上', health.value.problem))

  const first = await pollSource(folder, config, null, options)
  if (!first.ok) return steps.push(step('fail', '第一次 poll 出错', first.problem))
  steps.push(...batchSteps('第一次 poll（从头）', first.value.messages, first.value.dropped, now))
  if (first.value.cursor === null) steps.push(step('warn', '没有交回游标', '每次都会从头拉；重复的消息会按 id 去掉，但会多花时间'))

  const second = await pollSource(folder, config, first.value.cursor, options)
  if (!second.ok) return steps.push(step('fail', '第二次 poll 出错', second.problem))
  steps.push(...batchSteps('第二次 poll（接着上次的游标）', second.value.messages, second.value.dropped, now))
  const seen = new Set(first.value.messages.map((m) => m.id))
  const again = second.value.messages.find((m) => seen.has(m.id))
  if (again && first.value.cursor !== null) steps.push(step('warn', '第二次又交回了第一次的消息，游标没有往前走？', again.id))
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
  steps.push(step('ok', `viva-source.json：「${manifest.name}」（${manifest.id}），每 ${manifest.everyMinutes} 分钟拉一次`))

  const checked = checkConfigValues(manifest.config, values)
  if (checked.problem !== undefined) {
    steps.push(step('fail', '配置不对', checked.problem))
    return report()
  }
  const missing = missingFields(manifest.config, checked.values)
  if (missing.length) {
    steps.push(step('fail', '缺少必填的配置', `${missing.join('、')}（用 --config 文件或 --set 名称=值 给出）`))
    return report()
  }

  const dataDir = run.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'viva-source-check-'))
  const options: RunOptions = { ...run, dataDir }
  try {
    const started = commandFor(folder, options)
    if (!started.ok) {
      steps.push(step('fail', '启动不了', started.problem))
      return report()
    }
    steps.push(step('ok', `能启动：${started.value.command} ${started.value.args.join(' ')}`.trim()))
    const other = OTHER_ON_WINDOWS[manifest.run[0]]
    if (other && !manifest.runOn?.win32) steps.push(step('warn', `Windows 上没有 ${manifest.run[0]}`, `加上 "runOn": { "win32": … }，例如 ${other}`))
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
  lines.push(report.ok ? `\n可以安装${warnings ? `（有 ${warnings} 条提醒）` : ''}` : '\n还不能安装：先解决上面标 ✖ 的问题')
  return lines
}
