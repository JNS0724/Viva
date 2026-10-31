// npm run live: the live check before a release (docs/live-check.md). Starts Viva twice on one fresh profile with
// the real DeepSeek model (external phases live, then live-resume; test/smoke/live.ts), then writes smoke/live/report.md.
//
//   npm run live                          all 26 scenarios, 3 times each
//   npm run live -- --set core            the core ones (every beta)
//   npm run live -- --only steer,desk     the ones named
//   npm run live -- --repeat 1            once each
//   npm run live -- --app "/Applications/Viva.app/Contents/MacOS/Viva"   the installed app instead of this checkout
//   npm run live -- --dry                 the fake model: tries the check itself, not the model (most scenarios fail)
//
// The key comes from DEEPSEEK_API_KEY, or else from LIVE_ENV (default ~/.config/viva/live-test.env, one line
// DEEPSEEK_API_KEY=...), as for npm run live:memory; it is never printed or written to the report.
// Each run uses an owned temporary profile; the report stays in smoke/live.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { summarize } from './live-report.mjs'
import { runExternalScenario } from '../test/smoke/run-external.ts'
import type { PhaseReport } from '../test/smoke/live.ts'
import type { SmokePhase } from '../test/smoke/fixtures.ts'
import { repeatOf, selectScenarios } from '../test/smoke/live.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const ENV_FILE = process.env.LIVE_ENV || path.join(os.homedir(), '.config', 'viva', 'live-test.env')
const DRY_KEY = 'smoke-fake-key'

const { values: args } = parseArgs({
  options: {
    set: { type: 'string', default: 'full' },
    only: { type: 'string' },
    repeat: { type: 'string', default: '3' },
    app: { type: 'string' },
    out: { type: 'string', default: path.join(ROOT, 'smoke') },
    baseline: { type: 'string' },
    dry: { type: 'boolean', default: false },
  },
})

function fail(message: string): never {
  console.error(`[live] ${message}`)
  process.exit(2)
}

/** The key from the environment, else from ENV_FILE (kept from other users' eyes). */
function readKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim()
  if (fromEnv) return fromEnv
  if (!fs.existsSync(ENV_FILE)) fail(`没有 DEEPSEEK_API_KEY 环境变量，也没有找到 ${ENV_FILE}。`)
  // Windows has no group or other permission bits to check.
  if (process.platform !== 'win32' && (fs.statSync(ENV_FILE).mode & 0o077) !== 0) fail(`${ENV_FILE} 其他用户也能读，请先运行 chmod 600 ${ENV_FILE}`)
  const line = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).find((l) => l.startsWith('DEEPSEEK_API_KEY='))
  const key = line?.slice('DEEPSEEK_API_KEY='.length).trim()
  if (!key) fail(`${ENV_FILE} 里没有 DEEPSEEK_API_KEY=...`)
  return key
}

const readJson = <T>(file: string): T | null => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as T : null

const out = path.resolve(args.out)
const liveDir = path.join(out, 'live')
const key = args.dry ? DRY_KEY : readKey()
// The last run's results, to compare with; then a clean folder for this one.
const baseline = readJson<Parameters<typeof summarize>[1]>(args.baseline ? path.resolve(args.baseline) : path.join(liveDir, 'report.json'))
fs.mkdirSync(liveDir, { recursive: true })
for (const phase of ['live', 'live-resume']) fs.rmSync(path.join(liveDir, `report-${phase}.json`), { force: true })
if (baseline) fs.writeFileSync(path.join(out, 'live-baseline.json'), JSON.stringify(baseline, null, 2))

const only = args.only?.split(',').map((id) => id.trim()).filter(Boolean)
// The second launch is only for what needs the app started again (the history scenario).
const phases: SmokePhase[] = !only || only.includes('history') ? ['live', 'live-resume'] : ['live']
const started = Date.now()
const exits = []
process.env.LIVE_SET = args.set
process.env.LIVE_REPEAT = args.repeat
if (only) process.env.LIVE_ONLY = only.join(',')
else delete process.env.LIVE_ONLY
process.env.DEEPSEEK_API_KEY = key
repeatOf(process.env)
selectScenarios(process.env)
for (const name of ['SMOKE_PHASE', 'SMOKE_TEST_ROOT', 'SMOKE_FIXTURES']) delete process.env[name]
let problems: string[] = []
try {
  problems = await runExternalScenario({ phases, outputDirectory: out, executable: args.app, apiKey: args.dry ? undefined : key })
  exits.push(...phases.map(phase => ({ phase, status: problems.length ? 1 : 0, error: undefined as string | undefined })))
} catch (error) {
  exits.push(...phases.map(phase => ({ phase, status: 1, error: error instanceof Error ? error.message : String(error) })))
}

const reports = phases.map((phase) => readJson<PhaseReport>(path.join(liveDir, `report-${phase}.json`))).filter((report): report is PhaseReport => report !== null)
const { markdown, json } = summarize(reports, baseline)
const missing = exits.filter((e) => !reports.some((r) => r.phase === e.phase))
const notes = missing.map((e) => `- ⚠️ ${e.phase} 这次启动没有写出报告（退出码 ${e.status ?? '无'}${e.error ? `，${e.error}` : ''}），看上面的输出。`)
const text = [markdown, ...(notes.length ? ['## 启动问题', '', ...notes, ''] : []), `总用时 ${Math.round((Date.now() - started) / 60_000)} 分钟。`, ''].join('\n')
fs.writeFileSync(path.join(liveDir, 'report.md'), text)
fs.writeFileSync(path.join(liveDir, 'report.json'), JSON.stringify(json, null, 2))
console.log(`[live] 通过 ${json.totals.passed} / ${json.totals.scenarios}；报告：${path.join(liveDir, 'report.md')}`)
process.exit(json.totals.failed === 0 && missing.length === 0 && problems.length === 0 && exits.every(e => e.status === 0) ? 0 : 1)
