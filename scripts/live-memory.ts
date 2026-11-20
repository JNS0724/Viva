/**
 * Live check of the memory plugin against the real DeepSeek model: does the model save what it should,
 * as evidence-backed files, use what is pushed to it, and admit what it does not know? Costs a few model calls,
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
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { MemoryFileDetail, MemoryFileListResult } from '../src/memory/contracts/file-management.ts'
import type { HostMemoryCaller } from '../src/memory/contracts/host.ts'
import { objectOf } from '../src/memory/contracts/unknown-value.ts'
import { randomUUID } from 'node:crypto'
import { DEEPSEEK_DEFAULT, parseModelValue } from '../src/backend/model-providers.ts'
import { createAcpBridge } from '../src/backend/acp-bridge.ts'
import { createDesktopMemoryOwner } from '../src/backend/desktop-memory-owner.ts'
import { installedDshVersion, PERSONA, resolvePlugins } from '../src/backend/app-plugins.ts'
import { DSH_PROFILE } from '../src/backend/config.ts'
import { ensureDshProfile, vivaLayerFile } from '../src/backend/dsh-profile.ts'
import { dshEnv, dshRuntime } from '../src/backend/dsh-runtime.ts'
import { removeTree } from '../src/backend/remove-tree.ts'
import { testRequests } from '../test/fixtures/request-routing.ts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
/** The app's runtime: this script runs on the app's Electron as Node (or DSH_NODE), and so does dsh. */
const RUNTIME = dshRuntime({ env: process.env, execPath: process.execPath })
const ENV_FILE = process.env.LIVE_ENV || path.join(os.homedir(), '.config', 'viva', 'live-test.env')
const OUT_FILE = path.join(ROOT, 'smoke', 'live-memory.json')
const TURN_TIMEOUT_MS = 180_000

/** Each session is a fresh dsh conversation over the same memory.db. */
const SESSIONS = [
  [
    '我是支付平台部的后端负责人，直属上级是张三。',
    '记住：周报每周五下班前交给张三。',
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

/** The key from the environment (e.g. exported from the Keychain by the shell), else from ENV_FILE. */
export function readLiveMemoryKey() {
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

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} 超过 ${ms / 1000} 秒没有结束`)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

type Bridge = ReturnType<typeof createAcpBridge>
type BridgeEvent = Parameters<Parameters<typeof createAcpBridge>[0]['emit']>[0]
type ToolSummary = { name?: string, input?: unknown, status?: string }
type Injection = { session: string, turn: number, pushed: Array<{ text: string, names: string[] }> }

/** Collect the owner's authorized file view, including bodies and source references. */
export async function fileSnapshot(call: HostMemoryCaller): Promise<MemoryFileDetail[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const files: MemoryFileDetail[] = []
    let cursor: NonNullable<MemoryFileListResult['nextCursor']> | undefined
    let stale = false
    do {
      const page = await call('listFiles', { args: [{ limit: 100, ...(cursor ? { cursor } : {}) }] })
      if (page.status === 'stale') { stale = true; break }
      for (const item of page.items) {
        const detail = await call('readFile', { args: [item.identity] })
        if (!detail) continue
        if (detail.identity.kind !== item.identity.kind || detail.identity.id !== item.identity.id || detail.identity.workspace !== item.identity.workspace
          || detail.version.contentRevision !== item.version.contentRevision || detail.version.usageVersion !== item.version.usageVersion
          || detail.version.policyToken !== item.version.policyToken) { stale = true; break }
        files.push(detail)
      }
      if (stale) break
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    if (!stale) return files
  }
  throw new Error('The memory file snapshot changed repeatedly')
}

/** One turn: the answer, the tool calls with their arguments, and the permissions refused. */
async function ask(bridge: Bridge, events: readonly BridgeEvent[], question: string) {
  const from = events.length
  const sourceId = randomUUID(), session = bridge.currentSession()!
  await bridge.memory.call('sourceAlias', { operationId: sourceId, sourceId, session, conversation: session, text: question })
  await withTimeout(bridge.prompt(question, [], { sourceId, sourceText: question }), TURN_TIMEOUT_MS, `「${question}」`)
  const turn = events.slice(from)
  const tools = new Map<string, ToolSummary>()
  for (const event of turn) {
    if (event.type !== 'update') continue
    const { toolCallId, title, rawInput, status } = objectOf(event.update) ?? {}
    if (typeof toolCallId !== 'string' || !toolCallId) continue
    const known = tools.get(toolCallId) ?? {}
    tools.set(toolCallId, { ...known, ...(typeof title === 'string' && title ? { name: title } : {}),
      ...(rawInput ? { input: rawInput } : {}), ...(typeof status === 'string' && status ? { status } : {}) })
  }
  return {
    question,
    answer: turn.flatMap(event => {
      const update = objectOf(event.update)
      const content = objectOf(update?.content)
      return update?.sessionUpdate === 'agent_message_chunk' && typeof content?.text === 'string' ? [content.text] : []
    }).join(''),
    tools: [...tools.values()],
    refused: turn.filter(event => event.type === 'permission').map(event => {
      const tool = objectOf(event.toolCall)
      return tool?.title ?? tool?.toolCallId
    }),
    errors: turn.filter(event => event.type === 'error').map(event => event.message),
  }
}

/** Runs one dsh session over the shared memory.db; every permission request is refused. */
async function runSession({ questions, key, env, dshHome, workspace, memoryRoot }: {
  questions: readonly string[], key: string, env: NodeJS.ProcessEnv, dshHome: string, workspace: string, memoryRoot: string,
}) {
  const events: BridgeEvent[] = [], injected: Injection[] = []
  const memoryOwner = createDesktopMemoryOwner({ root: memoryRoot }, {
    onContextUsed: ({ session, turn, pushed }) => { injected.push({ session, turn, pushed }) },
  })
  const bridge = createAcpBridge({
    routing: testRequests(),
    dshBin: path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    nodeBin: RUNTIME.nodeBin,
    profile: DSH_PROFILE,
    overlay: vivaLayerFile(dshHome),
    cwd: workspace,
    memoryRequired: true,
    memoryOwner,
    env: dshEnv({ base: env, dshHome, runtime: RUNTIME, settings: { DEEPSEEK_API_KEY: key } }),
    emit: (event) => {
      events.push(event)
      if (event.type === 'permission' && typeof event.requestId === 'string') {
        const requestId = event.requestId
        setImmediate(() => bridge.respondPermission(requestId, null))
      }
    },
  })
  try {
    const { sessionId, model } = await withTimeout(memoryOwner.prepare(async () => {}).then(() => bridge.start()), TURN_TIMEOUT_MS, 'dsh 启动')
    const turns = []
    for (const question of questions) {
      const turn = await ask(bridge, events, question)
      turns.push(turn)
      process.stdout.write(`\n▶ ${question}\n  工具：${turn.tools.map((t) => t.name).join('、') || '无'}\n  回答：${turn.answer.slice(0, 160).replace(/\n/g, ' ')}\n`)
    }
    return { sessionId, model, turns, injected, files: await fileSnapshot(bridge.memory.call),
      cleanupPending: await bridge.memory.call('cleanupPending', { args: [] }),
      profile: await bridge.memory.call('profile', { args: [] }) }
  } finally {
    try { await bridge.dispose() } finally { await memoryOwner.close() }
  }
}

async function main() {
  const key = readLiveMemoryKey()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-memory-'))
  const dshHome = path.join(dir, 'dsh-home')
  const workspace = path.join(dir, 'workspace')
  fs.mkdirSync(workspace)
  const { plugins } = resolvePlugins({ codeRoot: ROOT, userData: dir, dshVersion: installedDshVersion(ROOT) })
  ensureDshProfile({ dshHome, profile: DSH_PROFILE, plugins, persona: PERSONA })
  // dshEnv drops any DEEPSEEK_BASE_URL left in the environment: this is the real API.
  const env = process.env
  const report: {
    startedAt: string,
    sessions: Awaited<ReturnType<typeof runSession>>[],
    files?: MemoryFileDetail[],
    cleanupPending?: number,
    profile?: Record<string, string>,
  } = { startedAt: new Date().toISOString(), sessions: [] }
  try {
    for (const questions of SESSIONS) {
      report.sessions.push(await runSession({ questions, key, env, dshHome, workspace, memoryRoot: path.join(dir, 'memory') }))
    }
    const latest = report.sessions.at(-1)
    report.files = latest?.files ?? []
    report.cleanupPending = latest?.cleanupPending ?? 0
    report.profile = Object.fromEntries(Object.entries(latest?.profile ?? {}).map(([field, entry]) => [field, entry.value]))
  } finally {
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
    fs.writeFileSync(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`)
    removeTree(dir)
  }
  process.stdout.write(`\n记忆文件：${JSON.stringify(report.files)}\n待清理副本：${report.cleanupPending}\n完整记录：${OUT_FILE}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((err) => {
  process.stderr.write(`live-memory: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
