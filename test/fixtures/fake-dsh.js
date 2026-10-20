/**
 * Test double for `dsh --profile <name>`: a real ACP agent over stdio that plays fixed scripts,
 * so integration tests and the smoke run exercise the same bridge code as a real session.
 * Started as `node fake-dsh.js --profile viva`. FAKE_DSH_DELAY_MS sets the pace (default 450 ms per step).
 * Like dsh, it connects to the stdio MCP servers a session declares and refuses the session when one fails.
 * It has no plugins: memory is tested with the real dsh and a fake model (test/fixtures/fake-llm.js).
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const STEP_MS = Number(process.env.FAKE_DSH_DELAY_MS ?? 450)
const PIECE_CHARS = 3
const PIECE_RATIO = 1 / 12
const LONG_TASK = /长任务/
/** Asked for 格式演示, the answer is Markdown of every kind the window renders, plus what it must not run. */
const MARKDOWN_DEMO = /格式演示/
export const MARKDOWN_ANSWER = [
  '## 本周进展',
  '',
  '对账系统重构**按计划推进**，*接口联调*还差一步，~~周三上线~~改为周五。详见 [需求文档](https://example.com/spec) 和 `recon_service`。',
  '',
  '- [x] 完成数据迁移',
  '- [ ] 补齐回归测试',
  '  1. 结算口径',
  '  2. 退款链路',
  '',
  '| 模块 | 负责人 | 进度 |',
  '|:--|:--|--:|',
  '| 结算 | 张三 | 80% |',
  '| 退款 | 李四 | 45% |',
  '',
  '```python',
  'def settle(day):',
  '    return [t for t in trades(day) if t.ok]',
  '```',
  '',
  '> 风险：测试环境下周二维护。',
  '',
  '---',
  '',
  '这些不该生效：<script>window.hacked = true</script> [点我](javascript:window.hacked=true) ![远程图](https://example.com/x.png)',
].join('\n')
const LONG_STEPS = 16
const LONG_STEP_RATIO = 1 / 3
const LONG_PIECE_CHARS = 12
const LONG_PIECE_RATIO = 1 / 20
const SESSION_PREFIX = 'fake-session-'
const MODELS = [
  { value: '["fake","fake-flash"]', name: 'Fake Flash' },
  { value: '["fake","fake-pro"]', name: 'Fake Pro' },
]
const EFFORTS = ['off', 'low', 'high', 'max']
/** As real dsh offers them (dsh-acp): English names, which the window shows in Chinese. */
const PERMISSION_OPTIONS = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
]

const cancelled = new Error('cancelled')

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled)
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(cancelled)
    }, { once: true })
  })
}

const pieces = (text, size) => {
  const chars = [...text]
  return Array.from({ length: Math.ceil(chars.length / size) }, (_, i) => chars.slice(i * size, (i + 1) * size).join(''))
}

function configOptions({ model, effort }) {
  return [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [{ group: 'fake', name: 'Fake', options: MODELS }] },
    {
      id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: effort,
      options: EFFORTS.map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) })),
    },
  ]
}

function longAnswer() {
  const days = Array.from({ length: LONG_STEPS }, (_, i) => `${String(i + 1).padStart(2, '0')}. 第 ${i + 1} 份笔记：记录了当天的进展、遇到的阻塞和第二天的计划，其中有两条待办还没有关闭，需要在周会上确认负责人和截止时间。`)
  return [
    `长任务演示完成：一共读取了 ${LONG_STEPS} 份笔记。下面是逐份摘要，内容足够长，用来检查长回复时的滚动行为。`,
    '',
    ...days,
    '',
    '总结：大部分阻塞集中在接口联调和测试环境，建议下周优先处理；其余待办可以按原计划推进。',
  ].join('\n')
}

/** Connects to each declared stdio MCP server; any failure rejects the whole session, as in dsh. */
async function connectMcp(servers = []) {
  const clients = new Map()
  for (const [index, server] of servers.entries()) {
    if (server.type === 'http') continue
    if (!path.isAbsolute(server.command)) throw new Error(`Invalid params: mcpServers[${index}].command must be an absolute path`)
    const client = new Client({ name: 'fake-dsh', version: '0.0.0' })
    const env = Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value]))
    try {
      await client.connect(new StdioClientTransport({ command: server.command, args: server.args ?? [], env, stderr: 'ignore' }))
      await client.listTools()
    } catch {
      await Promise.all([...clients.values()].map((c) => c.close()))
      throw new Error(`mcp-client(${server.name}): initial connection or tool synchronization failed`)
    }
    clients.set(server.name, client)
  }
  return clients
}

const closeMcp = (session) => Promise.all([...(session?.mcp?.values() ?? [])].map((client) => client.close().catch(() => {})))

function createAgent(conn) {
  const sessions = new Map()

  const openSession = (sessionId, cwd, mcp) => {
    const session = { cwd, model: MODELS[0].value, effort: 'high', turn: null, mcp }
    sessions.set(sessionId, session)
    return session
  }

  /** Helpers bound to one turn: every await honours cancellation. */
  function turnTools(sessionId, signal) {
    const send = (update) => conn.sessionUpdate({ sessionId, update })
    const step = async (update, ratio = 1) => {
      await sleep(STEP_MS * ratio, signal)
      await send(update)
    }
    const stream = async (kind, text, size = PIECE_CHARS, ratio = PIECE_RATIO) => {
      await sleep(STEP_MS, signal)
      for (const piece of pieces(text, size)) {
        await send({ sessionUpdate: kind, content: { type: 'text', text: piece } })
        await sleep(STEP_MS * ratio, signal)
      }
    }
    const tool = (toolCallId, title, kind, extra = {}) => ({ sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'in_progress', ...extra })
    const status = (toolCallId, value) => ({ sessionUpdate: 'tool_call_update', toolCallId, status: value })
    return { step, stream, tool, status }
  }

  async function defaultScript(sessionId, session, text, signal) {
    const { step, stream, tool, status } = turnTools(sessionId, signal)
    const id = (name) => `${name}-${randomUUID()}`
    const [read, fetch, write] = [id('read'), id('fetch'), id('edit')]
    const model = MODELS.find((m) => m.value === session.model).name
    await stream('agent_thought_chunk', '先确认你要的结果，再看看工作区里有什么可以用的材料。')
    await step(tool(read, '读取工作区文件列表', 'read', { locations: [{ path: session.cwd }] }))
    await step(status(read, 'completed'))
    await step(tool(fetch, '查找相关资料', 'fetch', { rawInput: { url: `https://example.com/search?q=${encodeURIComponent(text.slice(0, 40))}` } }))
    await step(status(fetch, 'completed'))
    await stream('agent_message_chunk', `收到：「${text}」。这是测试用的假 dsh 的固定回复（模型 ${model}，推理强度 ${session.effort}）。思考和工具调用会出现在右侧「过程」里。`)
    // Like real dsh: the tool call carries the tool's name and arguments, the request only its id.
    const summary = path.join(session.cwd, 'summary.md')
    await step(tool(write, 'write', 'other', { status: 'pending', rawInput: { path: summary, content: '# 摘要' }, locations: [{ path: summary }] }))
    const decision = await conn.requestPermission({
      sessionId,
      toolCall: { toolCallId: write },
      options: PERMISSION_OPTIONS,
    })
    if (signal.aborted) throw cancelled
    const allowed = decision.outcome.outcome === 'selected' && decision.outcome.optionId === 'allow-once'
    await step(status(write, allowed ? 'completed' : 'failed'))
    await stream('agent_message_chunk', allowed ? '已写入 summary.md（假 dsh，没有真正写入磁盘）。' : '好的，没有写入。')
  }

  async function longScript(sessionId, session, signal) {
    const { step, stream, tool, status } = turnTools(sessionId, signal)
    await stream('agent_thought_chunk', '这是一个长任务：逐份读取笔记，最后汇总。')
    for (let day = 1; day <= LONG_STEPS; day += 1) {
      const name = `day-${String(day).padStart(2, '0')}.md`
      const toolId = `read-${day}-${randomUUID()}`
      await step(tool(toolId, `读取 notes/${name}`, 'read', { locations: [{ path: path.join(session.cwd, 'notes', name) }] }), LONG_STEP_RATIO)
      await step(status(toolId, 'completed'), LONG_STEP_RATIO)
    }
    await stream('agent_message_chunk', longAnswer(), LONG_PIECE_CHARS, LONG_PIECE_RATIO)
  }

  const sessionOrThrow = (sessionId) => {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`unknown session: ${sessionId}`)
    return session
  }

  return {
    async initialize(params) {
      return {
        protocolVersion: params.protocolVersion,
        agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } },
        authMethods: [],
      }
    },
    async authenticate() {
      return {}
    },
    async newSession(params) {
      const sessionId = `${SESSION_PREFIX}${randomUUID()}`
      const mcp = await connectMcp(params.mcpServers)
      return { sessionId, configOptions: configOptions(openSession(sessionId, params.cwd, mcp)) }
    },
    /** Sessions of earlier fake processes can be resumed too, like dsh sessions across launches. */
    async resumeSession(params) {
      if (!params.sessionId.startsWith(SESSION_PREFIX)) throw new Error(`session is not resumable: ${params.sessionId}`)
      const mcp = await connectMcp(params.mcpServers)
      const existing = sessions.get(params.sessionId)
      await closeMcp(existing)
      const session = existing ? { ...existing, mcp } : openSession(params.sessionId, params.cwd, mcp)
      sessions.set(params.sessionId, session)
      return { configOptions: configOptions(session) }
    },
    async closeSession(params) {
      const session = sessions.get(params.sessionId)
      session?.turn?.abort()
      await closeMcp(session)
      sessions.delete(params.sessionId)
      return {}
    },
    async setSessionConfigOption(params) {
      const session = sessionOrThrow(params.sessionId)
      const field = { model: 'model', reasoning_effort: 'effort' }[params.configId]
      if (!field) throw new Error(`unknown session config option: ${params.configId}`)
      const allowed = params.configId === 'model' ? MODELS.map((m) => m.value) : EFFORTS
      if (!allowed.includes(params.value)) throw new Error(`unknown ${params.configId} option: ${params.value}`)
      session[field] = params.value
      return { configOptions: configOptions(session) }
    },
    async prompt(params) {
      const session = sessionOrThrow(params.sessionId)
      const controller = new AbortController()
      session.turn = controller
      const text = params.prompt.map((block) => block.text ?? '').join('\n')
      try {
        if (LONG_TASK.test(text)) await longScript(params.sessionId, session, controller.signal)
        else if (MARKDOWN_DEMO.test(text)) await turnTools(params.sessionId, controller.signal).stream('agent_message_chunk', MARKDOWN_ANSWER, LONG_PIECE_CHARS, LONG_PIECE_RATIO)
        else await defaultScript(params.sessionId, session, text, controller.signal)
        return { stopReason: 'end_turn' }
      } catch (err) {
        if (err === cancelled) return { stopReason: 'cancelled' }
        throw err
      } finally {
        session.turn = null
      }
    },
    async cancel(params) {
      sessions.get(params.sessionId)?.turn?.abort()
    },
  }
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
new AgentSideConnection(createAgent, stream)
