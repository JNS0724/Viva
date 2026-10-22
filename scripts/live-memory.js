/**
 * Live check of the memory plugin against the real DeepSeek model: does the model save what it should,
 * with keywords, use what is pushed to it, and admit what it does not know? Costs a few model calls,
 * so it is run by hand (`npm run live:memory`), never by `npm test`.
 *
 * The key comes from the DEEPSEEK_API_KEY environment variable, or else from LIVE_ENV (default
 * ~/.config/viva/live-test.env, one line `DEEPSEEK_API_KEY=...`), and is never printed. Everything else is isolated: a temporary dsh home,
 * memory.db and workspace, removed afterwards; the user's ~/.dsh and app data are not touched.
 * Any permission the model asks for (writing files, running commands) is refused.
 * The transcript, tool calls and what was injected go to smoke/live-memory.json.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openMemoryDb } from '../plugins/memory/lib/store.js'
import { createAcpBridge } from '../src/main/acp-bridge.js'
import { installedDshVersion, PERSONA, resolvePlugins } from '../src/main/app-plugins.ts'
import { DSH_PROFILE } from '../src/main/config.ts'
import { ensureDshProfile } from '../src/main/dsh-profile.js'
import { dshEnv, dshRuntime } from '../src/main/dsh-runtime.ts'
import { removeTree } from '../src/main/remove-tree.ts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
/** The app's runtime: this script runs on the app's Electron as Node (or DSH_NODE), and so does dsh. */
const RUNTIME = dshRuntime({ env: process.env, execPath: process.execPath })
const ENV_FILE = process.env.LIVE_ENV || path.join(os.homedir(), '.config', 'viva', 'live-test.env')
const OUT_FILE = path.join(ROOT, 'smoke', 'live-memory.json')
const TURN_TIMEOUT_MS = 180_000

/** Each session is a fresh dsh conversation over the same memory.db. */
const SESSIONS = [
  [
    '我是支付平台部的后端负责人，直属上级是张三。记住：周报每周五下班前交给张三。',
    '以后回答我，先给结论再展开。',
  ],
  [
    '这周的周报要交给谁？什么时候交？',
    '我们和财务定的结算口径是什么？',
    '张三下个月调去风控部了，从下周一开始我的直属上级是李四。',
  ],
  [
    '我现在的直属上级是谁？周报交给谁？',
  ],
]
/** The background pass writes after a turn; give it time before the next session or the final read. */
const SETTLE_MS = 20_000

/** The key from the environment (e.g. exported from the Keychain by the shell), else from ENV_FILE. */
function readKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim()
  if (fromEnv) return fromEnv
  if (!fs.existsSync(ENV_FILE)) {
    throw new Error(`没有 DEEPSEEK_API_KEY 环境变量，也没有找到 ${ENV_FILE}。`)
  }
  // Windows has no group or other permission bits to check.
  if (process.platform !== 'win32' && (fs.statSync(ENV_FILE).mode & 0o077) !== 0) throw new Error(`${ENV_FILE} 其他用户也能读，请先运行 chmod 600 ${ENV_FILE}`)
  const line = fs.readFileSync(ENV_FILE, 'utf8').split('\n').find((l) => l.startsWith('DEEPSEEK_API_KEY='))
  const key = line?.slice('DEEPSEEK_API_KEY='.length).trim()
  if (!key) throw new Error(`${ENV_FILE} 里没有 DEEPSEEK_API_KEY=...`)
  return key
}

const withTimeout = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} 超过 ${ms / 1000} 秒没有结束`)), ms)),
])

/** One turn: the answer, the tool calls with their arguments, and the permissions refused. */
async function ask(bridge, events, question) {
  const from = events.length
  await withTimeout(bridge.prompt(question), TURN_TIMEOUT_MS, `「${question}」`)
  const turn = events.slice(from)
  const tools = new Map()
  for (const event of turn.filter((e) => e.type === 'update' && e.update.toolCallId)) {
    const { toolCallId, title, rawInput, status } = event.update
    const known = tools.get(toolCallId) ?? {}
    tools.set(toolCallId, { ...known, ...(title ? { name: title } : {}), ...(rawInput ? { input: rawInput } : {}), ...(status ? { status } : {}) })
  }
  return {
    question,
    answer: turn.filter((e) => e.update?.sessionUpdate === 'agent_message_chunk').map((e) => e.update.content.text).join(''),
    tools: [...tools.values()],
    refused: turn.filter((e) => e.type === 'permission').map((e) => e.toolCall?.title ?? e.toolCall?.toolCallId),
    errors: turn.filter((e) => e.type === 'error').map((e) => e.message),
  }
}

/** Runs one dsh session over the shared memory.db; every permission request is refused. */
async function runSession({ questions, key, env, dshHome, workspace, memoryFile }) {
  const events = []
  const bridge = createAcpBridge({
    dshBin: path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    nodeBin: RUNTIME.nodeBin,
    cwd: workspace,
    env: dshEnv({ base: env, dshHome, runtime: RUNTIME, settings: { DEEPSEEK_API_KEY: key } }),
    emit: (event) => {
      events.push(event)
      if (event.type === 'permission') setImmediate(() => bridge.respondPermission(event.requestId, null))
    },
  })
  try {
    const { sessionId, model } = await withTimeout(bridge.start(), TURN_TIMEOUT_MS, 'dsh 启动')
    const turns = []
    for (const question of questions) {
      const turn = await ask(bridge, events, question)
      turns.push(turn)
      process.stdout.write(`\n▶ ${question}\n  工具：${turn.tools.map((t) => t.name).join('、') || '无'}\n  回答：${turn.answer.slice(0, 160).replace(/\n/g, ' ')}\n`)
    }
    // The background pass runs inside this dsh: let it finish before the process goes.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    const db = openMemoryDb({ file: memoryFile })
    const injected = db.injectionsAfter(0, sessionId)
    db.close()
    return { sessionId, model, turns, injected }
  } finally {
    await bridge.dispose()
  }
}

async function main() {
  const key = readKey()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-memory-'))
  const memoryFile = path.join(dir, 'memory.db')
  const dshHome = path.join(dir, 'dsh-home')
  const workspace = path.join(dir, 'workspace')
  fs.mkdirSync(workspace)
  const { plugins } = resolvePlugins({ codeRoot: ROOT, userData: dir, dshVersion: installedDshVersion(ROOT) })
  ensureDshProfile({ dshHome, profile: DSH_PROFILE, plugins, persona: PERSONA })
  // dshEnv drops any DEEPSEEK_BASE_URL left in the environment: this is the real API.
  const env = process.env
  const report = { startedAt: new Date().toISOString(), sessions: [] }
  try {
    for (const questions of SESSIONS) {
      report.sessions.push(await runSession({ questions, key, env, dshHome, workspace, memoryFile }))
    }
    const db = openMemoryDb({ file: memoryFile })
    report.memories = db.listMemories().items.map(({ text, kind, keywords, source }) => ({ text, kind, keywords, source }))
    report.invalid = db.listInvalid().map(({ text, supersededBy, invalidatedBy }) => ({ text, supersededBy, invalidatedBy }))
    report.synthesis = db.latestSynthesis()
    report.profile = Object.fromEntries(Object.entries(db.getProfile()).map(([field, entry]) => [field, entry.value]))
    db.close()
  } finally {
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
    fs.writeFileSync(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`)
    removeTree(dir)
  }
  process.stdout.write(`\n记下的记忆：${JSON.stringify(report.memories)}\n已失效：${JSON.stringify(report.invalid)}\n你填写的画像：${JSON.stringify(report.profile)}\n助手整理的画像（${report.synthesis ? new Date(report.synthesis.createdAt).toLocaleString() : '无'}）：\n${report.synthesis?.text ?? ''}\n完整记录：${OUT_FILE}\n`)
}

main().catch((err) => {
  process.stderr.write(`live-memory: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
