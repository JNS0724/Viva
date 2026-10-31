// npm run live: the live check before a release (docs/live-check.md). Starts Viva twice on one fresh profile with
// the real DeepSeek model (SMOKE_PHASE=live, then live-resume; test/smoke/live.ts), then writes smoke/live/report.md.
//
//   npm run live                          all 26 scenarios, 3 times each
//   npm run live -- --set core            the core ones (every beta)
//   npm run live -- --only steer,desk     the ones named
//   npm run live -- --repeat 1            once each
//   npm run live -- --app "/Applications/Viva.app/Contents/MacOS/Viva"   the installed app instead of this checkout
//   npm run live -- --dry                 the fake model: tries the check itself, not the model (most scenarios fail)
//
// The key comes from DEEPSEEK_API_KEY, or else from LIVE_ENV (default ~/.config/viva/live-test.env, one line
// DEEPSEEK_API_KEY=...), as for npm run live:memory; it is never printed or written to the report. Everything the
// app keeps goes to smoke/userData-live; the user's own Viva data and ~/.dsh are not touched.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { summarize } from './live-report.mjs'

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

function fail(message) {
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

/** This checkout's Electron on the built code, or the installed app. */
function appCommand() {
  if (args.app) {
    if (!fs.existsSync(args.app)) fail(`找不到 ${args.app}`)
    return { command: args.app, argv: [] }
  }
  if (!fs.existsSync(path.join(ROOT, 'out', 'src', 'main', 'main.js'))) fail('先运行 npm run build（npm run live 会自己先构建）')
  return { command: createRequire(import.meta.url)('electron'), argv: ['.'] }
}

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null)

const out = path.resolve(args.out)
const liveDir = path.join(out, 'live')
const key = args.dry ? DRY_KEY : readKey()
const { command, argv } = appCommand()
// The last run's results, to compare with; then a clean folder for this one.
const baseline = readJson(args.baseline ? path.resolve(args.baseline) : path.join(liveDir, 'report.json'))
fs.rmSync(liveDir, { recursive: true, force: true })
fs.mkdirSync(liveDir, { recursive: true })
if (baseline) fs.writeFileSync(path.join(out, 'live-baseline.json'), JSON.stringify(baseline, null, 2))

const only = args.only?.split(',').map((id) => id.trim()).filter(Boolean)
// The second launch is only for what needs the app started again (the history scenario).
const phases = !only || only.includes('history') ? ['live', 'live-resume'] : ['live']
const started = Date.now()
const exits = []
for (const phase of phases) {
  console.log(`[live] ${phase}: ${args.app ?? 'this checkout'}${args.dry ? ' (dry, fake model)' : ''}`)
  const result = spawnSync(command, argv, {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      SMOKE_PHASE: phase,
      SMOKE_OUT: out,
      // The installed app has no test folder: the scenarios' fixtures (an MCP server) come from here.
      SMOKE_FIXTURES: path.join(ROOT, 'test', 'fixtures'),
      SMOKE_TEST_ROOT: path.join(ROOT, 'out', 'test', 'smoke'),
      DEEPSEEK_API_KEY: key,
      LIVE_SET: args.set,
      LIVE_REPEAT: args.repeat,
      ...(only ? { LIVE_ONLY: only.join(',') } : {}),
      ...(args.dry ? { LIVE_DRY: '1' } : {}),
    },
  })
  exits.push({ phase, status: result.status, error: result.error?.message })
}

const reports = phases.map((phase) => readJson(path.join(liveDir, `report-${phase}.json`))).filter(Boolean)
const { markdown, json } = summarize(reports, baseline)
const missing = exits.filter((e) => !reports.some((r) => r.phase === e.phase))
const notes = missing.map((e) => `- ⚠️ ${e.phase} 这次启动没有写出报告（退出码 ${e.status ?? '无'}${e.error ? `，${e.error}` : ''}），看上面的输出。`)
const text = [markdown, ...(notes.length ? ['## 启动问题', '', ...notes, ''] : []), `总用时 ${Math.round((Date.now() - started) / 60_000)} 分钟。`, ''].join('\n')
fs.writeFileSync(path.join(liveDir, 'report.md'), text)
fs.writeFileSync(path.join(liveDir, 'report.json'), JSON.stringify(json, null, 2))
console.log(`[live] 通过 ${json.totals.passed} / ${json.totals.scenarios}；报告：${path.join(liveDir, 'report.md')}`)
process.exit(json.totals.failed === 0 && missing.length === 0 ? 0 : 1)
