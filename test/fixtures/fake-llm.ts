/**
 * A stand-in for the DeepSeek Messages API, for running the real dsh (and the memory plugin) without a key:
 * point `DEEPSEEK_BASE_URL` at `url`. Every request is kept in `requests` so tests can see exactly what the
 * model was given. Its "model" is a few fixed rules on the user's latest words.
 *
 * Offered commit_route (the main conversation, plugins/routing), it first routes each request the way the rules
 * below would do it: work goes to a task (start; 「告诉后台的…」 a message after list_background_tasks), the app's
 * settings are an app_operation followed by their tool, a missing city is a clarify asked in text, anything else a
 * reply; then the rules below go on with the request's words. Without commit_route (a task) the rules apply as they are:
 *
 * - 「记住：X」 → calls memory_remember with only the exact text X;
 * - 「查一下 X」 → calls memory_recall with X;
 * - 「…明天…天气…」 → asks which city with ask_user_question, then answers for the city it was told;
 * - 「…接入演示服务…」 → sets up DEMO_SERVER with viva_mcp_add (its key named, never given), then says the result,
 *   or, told 「再问我城市」 too, asks which city as for the weather;
 * - 「后台做：X」 → routed to a background task, X its brief;
 * - a background task's result (the app's 【后台任务结束】 note) → 「已看过后台结果：T」, T the first task's title;
 * - 「告诉后台的「T」：Z」 → routed as a message Z to task T, found with list_background_tasks;
 * - 「删掉 X」 → removes X with the shell (in a task: routed there);
 * - asked by dsh's Auto review about a step → allows it, unless it removes something;
 * - after a tool result → says what the tool did;
 * - 「…到时候帮我…」 → proposes a schedule with schedule_create (FOLLOWUP below), due in a minute so a smoke run
 *   sees it run;
 * - anything else → 「收到：…」, prefixed with what background it was given;
 */
import http from 'node:http'
import type { ServerResponse } from 'node:http'
import { z } from 'zod'
import { objectOf } from '../../src/shared/unknown-value.ts'
import { currentTurnTextParts } from './model-user-text.ts'
import { requestsIn, withoutHeaders } from '../../src/shared/request-routing/header.ts'
import { APP_OPERATIONS } from '../../src/shared/request-routing/protocol.ts'

type Message = { role?: string, content?: unknown }
const partSchema = z.object({ type: z.string().optional(), text: z.string().optional(), name: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(), content: z.unknown().optional() }).passthrough()
type Part = z.output<typeof partSchema>
const requestSchema = z.object({ model: z.string().optional(), system: z.unknown().optional(),
  messages: z.array(z.object({ role: z.string().optional(), content: z.unknown().optional() }).passthrough()),
  tools: z.array(z.object({ name: z.string() }).passthrough()).optional() }).passthrough()
type Request = z.output<typeof requestSchema>
const answerSchema = z.object({ text: z.string().optional(), tool: z.object({ name: z.string(), input: z.record(z.string(), z.unknown()) }).optional(),
  httpError: z.number().int().min(400).max(599).optional(), delayMs: z.number().nonnegative().optional(),
  waitFor: z.custom<Promise<unknown>>(value => value instanceof Promise).optional() })
  .refine(answer => answer.text !== undefined || answer.tool !== undefined || answer.httpError !== undefined, 'Fixture response requires text, a tool, or an HTTP failure')
type Answer = z.output<typeof answerSchema>
type Decide = (request: object) => object | null
type Action = { kind: string, brief?: string, text?: string, question?: string } & Record<string, unknown>
type Goal = { goal: string, disposition: string }

const REMEMBER = /记住[:：]\s*(.+)$/s
const RECALL = /查一下\s*(.+)$/s
const WEATHER = /明天.*天气/
const CONNECT = /接入演示服务/
const THEN_ASK = /再问我城市/
const FOLLOW = /到时候帮我/
/** The app's note when a background task ended (backend/task-reports.ts), and the first task it names. */
const TASK_REPORT = /^【后台任务结束】[\s\S]*?任务：「([^」]+)」/
/** 「后台做：X」: a job for the background, as a brief. */
const HAND_OFF = /^后台做：([\s\S]+)$/
/** 「告诉后台的「T」：Z」: words for the background task titled T. */
const TELL = /^告诉后台的「([^」]+)」：([\s\S]+)$/
/**
 * What the fake proposes to schedule when asked 「…到时候帮我…」: once, a minute from now, so it is still ahead when
 * the user says yes on the card, and a smoke run sees it run.
 */
export const FOLLOWUP = Object.freeze({ title: '周报', prompt: '按上周的模板起草周报' })
export const FOLLOWUP_AHEAD_MS = 60_000
export const followupProposal = (now = Date.now()) => ({ ...FOLLOWUP, kind: 'at', at: new Date(now + FOLLOWUP_AHEAD_MS).toISOString() })
/** What the fake asks to set up: a local server whose key the user types in the window. */
export const DEMO_SERVER = Object.freeze({ name: 'demo', command: 'node', args: ['demo-mcp.js'], secrets: ['DEMO_TOKEN'] })
export const CITY_QUESTION = Object.freeze({
  id: 'city', question: '你想看哪个城市的天气？', header: '城市', options: [{ label: '上海' }, { label: '北京' }],
})
const CONTEXT_OPEN = '<about-user>'
const CARRY_CLOSE = '</以前的记录>\n\n用户现在说：'
/** 「发邮件…」 / 「存草稿…」 call the MCP tool whose name ends so; dsh prefixes it with the hashed server name. */
const MAIL = [[/^发邮件/, '__send_email'], [/^存草稿/, '__create_draft']] as const

const partsOf = (message: Message | undefined): Part[] => (Array.isArray(message?.content) ? message.content : [{ type: 'text', text: message?.content }])
  .flatMap((part: unknown) => { const parsed = partSchema.safeParse(part); return parsed.success ? [parsed.data] : [] })
const rawTexts = (message: Message) => partsOf(message).flatMap(part => part.type === 'text' && part.text !== undefined ? [part.text] : [])
/** The texts of a message, the app's request headers left out: the rules read the user's words. */
const textParts = (message: Message) => rawTexts(message).map(withoutHeaders)

/** Says what background came with the question: the fixed layer, and how many pushed memories. */
function backgroundOf(texts: readonly string[]) {
  const block = texts.find((text) => text.startsWith(CONTEXT_OPEN))
  if (!block) return ''
  const fixed = block.includes('【记忆规则】') ? '画像' : ''
  const pushed = block.split('\n').filter((line) => line.startsWith('- ') && line.endsWith('〕')).length
  const parts = [fixed, pushed ? `${pushed} 条相关记忆` : ''].filter(Boolean)
  return `我已经了解你的背景（${parts.join('、')}）。`
}

/** The text of the user's messages at the end of the request (this turn's), oldest first. */
function trailingUserTexts(messages: readonly Message[]) {
  let start = messages.length
  while (start > 0 && messages[start - 1].role === 'user') start -= 1
  return messages.slice(start).flatMap(textParts)
}

/** Native inbox notices can follow the result before the next model request. */
function trailingToolResult(messages: readonly Message[]): Part | undefined {
  let start = messages.length
  while (start > 0 && messages[start - 1].role === 'user') start -= 1
  const parts = messages.slice(start).flatMap(partsOf)
  const hasNewInput = parts.some(part => {
    if (part.type === 'tool_result') return false
    if (part.type !== 'text' || typeof part.text !== 'string' || requestsIn(part.text).length > 0) return true
    return currentTurnTextParts([part.text]).some(text => !text.startsWith(CONTEXT_OPEN) && !TASK_REPORT.test(text))
  })
  return hasNewInput ? undefined : parts.findLast(part => part.type === 'tool_result')
}

function currentWords(text: string) {
  // Test responder ignores the trusted delivery suffix; production admission uses exact owner aliases.
  text = text.replace(/\n\n<memory-delivery id="[a-f0-9-]+" \/>$/u, '')
  if (!text.startsWith('以下是这个话题以前的记录（最近 ')) return text
  const end = text.lastIndexOf(CARRY_CLOSE)
  return end < 0 ? text : text.slice(end + CARRY_CLOSE.length).trimStart()
}

/**
 * The user's words: the first text of the turn's user messages that is not the memory block. What dsh and the
 * plugins add (the block, notices) comes after them, in the same message or, in a forked session, in others.
 */
export const questionOf = (messages: readonly Message[]) => currentWords(currentTurnTextParts(trailingUserTexts(messages)).find((text) => !text.startsWith(CONTEXT_OPEN)) ?? '')

/** After a tool result the turn's last user message is that result: the words the user said come before it. */
export const lastWords = (messages: readonly Message[]) => currentWords(messages
  .filter((message) => message.role === 'user')
  .flatMap(textParts)
  .filter((text) => !text.startsWith(CONTEXT_OPEN))
  .at(-1) ?? '')

/**
 * What the user asked in this turn, for deciding after a tool result: the first words of the last run of user
 * messages with text. dsh may add messages of its own after the user's words (a fresh session's runtime context).
 */
const askedWords = (messages: readonly Message[]) => {
  const hasText = (message: Message) => message.role === 'user' && textParts(message).length > 0
  let end = messages.length - 1
  while (end >= 0 && !hasText(messages[end])) end -= 1
  let start = end
  while (start > 0 && messages[start - 1].role === 'user') start -= 1
  return currentWords(messages.slice(start, end + 1).flatMap(textParts).find((text) => !text.startsWith(CONTEXT_OPEN)) ?? '')
}

function lastToolUse(messages: readonly Message[]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const use = partsOf(messages[i]).find((part) => part.type === 'tool_use')
    if (use) return use
  }
  return null
}

const resultText = (result: Part) => (Array.isArray(result.content) ? result.content.map((part: unknown) => {
  const value = objectOf(part)?.text
  return typeof value === 'string' ? value : ''
}).join('') : String(result.content ?? ''))

function memoryResult(result: Part): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(resultText(result))
    if (typeof parsed === 'string') return objectOf(JSON.parse(parsed))
    const record = objectOf(parsed)
    return typeof record?.text === 'string' ? objectOf(JSON.parse(record.text)) : record
  } catch {
    return null
  }
}

/** What the user answered to the city question, or null when the tool came back without an answer. */
function cityFrom(result: Part): string | null {
  try {
    const payload = memoryResult(result)
    const answer = Array.isArray(payload?.answers) ? payload.answers.map((item: unknown) => objectOf(item)).find(item => item?.id === CITY_QUESTION.id) : null
    const first = Array.isArray(answer?.selected) ? answer.selected[0] : null
    return typeof answer?.custom === 'string' && answer.custom ? answer.custom : typeof first === 'string' ? first : null
  } catch {
    return null
  }
}

/** The task titled `title` in what list_background_tasks returned, or null. */
function taskTitled(result: Part, title: string): string | null {
  try {
    const payload = memoryResult(result)
    const task = Array.isArray(payload?.tasks) ? payload.tasks.map((item: unknown) => objectOf(item)).find(item => item?.title === title) : null
    return typeof task?.taskId === 'string' ? task.taskId : null
  } catch {
    return null
  }
}

function afterTool(request: Request, messages: readonly Message[], result: Part): Answer {
  const use = lastToolUse(messages)
  if (use?.name === 'ask_user_question') {
    const city = cityFrom(result)
    return { text: city ? `好的，按${city}来看：明天多云转晴。` : `没问到城市：${resultText(result)}` }
  }
  // 「…再问我城市」: once the server is dealt with, it asks which city (a question later in the turn).
  if (use?.name === 'viva_mcp_add' && THEN_ASK.test(askedWords(messages))) {
    return hasTool(request, 'ask_user_question') ? { tool: { name: 'ask_user_question', input: { questions: [CITY_QUESTION] } } } : { text: `配置结果：${resultText(result)}。${CITY_QUESTION.question}` }
  }
  if (use?.name === 'viva_mcp_add') return { text: `配置结果：${resultText(result)}` }
  if (use?.name === 'memory_recall') {
    const clarification = objectOf(memoryResult(result)?.clarification)
    if (typeof clarification?.ref === 'string') return { tool: { name: 'memory_clarify', input: { ref: clarification.ref } } }
  }
  if (use?.name === 'memory_clarify') {
    const reply = memoryResult(result), answer = objectOf(reply?.answer)
    const first = Array.isArray(answer?.answers) ? objectOf(answer.answers[0]) : null
    const selected = Array.isArray(first?.selected) ? first.selected[0] : null
    const value = typeof first?.custom === 'string' ? first.custom : typeof selected === 'string' ? selected : null
    return { text: reply?.status === 'answered' && value ? `这次采用：${value}` : '没有获得可用的澄清回答。' }
  }
  const output = JSON.stringify(result.content)
  if (use?.name !== 'memory_remember') return { text: `查到了：${output}` }
  return { text: memoryResult(result)?.status === 'accepted' && typeof use.input?.text === 'string'
    ? `好的，我记住了：${use.input.text}` : `没能记住：${output}` }

}

const systemText = (request: Request) => (Array.isArray(request.system) ? request.system.map((part: unknown) => {
  const value = objectOf(part)?.text
  return typeof value === 'string' ? value : ''
}).join('\n') : String(request.system ?? ''))
/** dsh's Auto review asks the model about each pending step; its request starts with this section. */
const REVIEWER = 'REVIEW_POLICY'
/** 「删掉 X」: removes X with the shell, which the fake reviewer will not allow by itself. */
const DELETE = /^删掉\s*(\S+)/
const SHELLS = ['bash', 'pwsh']

/** Plays the Auto reviewer: removing anything goes to the user, everything else is let through. */
function review(request: Request): Answer {
  const removes = /rm -rf|Remove-Item/.test(JSON.stringify(request.messages))
  return { text: JSON.stringify(removes ? { risk: 'medium', decision: 'deny', reason: '要删除原有的文件' } : { risk: 'low', decision: 'allow' }) }
}

const ROUTE = 'commit_route'
const hasTool = (request: Request, name: string) => (request.tools ?? []).some((tool) => tool.name === name)
/** A routing decision; one handing work over says so to the user in its notice, as a main agent there does. */
const commit = (requestId: string, goals: readonly Goal[], actions: readonly Action[]): Answer => {
  const handed = actions.find((action) => action.kind === 'start' || action.kind === 'message' || action.kind === 'stop')
  const notice = handed?.kind === 'start' ? `已经交给后台：${handed.brief}` : handed?.kind === 'message' ? `已经转告：${handed.text}` : handed ? '已经停下那个任务' : undefined
  return { tool: { name: ROUTE, input: { requestId, ...(notice ? { notice } : {}), goals, actions } } }
}
const toolUses = (messages: readonly Message[]) => messages.flatMap((message) => partsOf(message).filter((part) => part.type === 'tool_use'))
/** The requests the app put in the conversation, oldest first, each with its words. */
const requestsOf = (messages: readonly Message[]) => messages.filter((message) => message.role === 'user').flatMap(rawTexts).flatMap(requestsIn)
  .map((request) => ({ id: request.id, words: currentWords(request.words).trim() }))
const lastRouted = (messages: readonly Message[]) => toolUses(messages).filter((use) => use.name === ROUTE).at(-1)?.input?.requestId ?? null
const pendingRequest = (messages: readonly Message[]) => {
  const routed = new Set(toolUses(messages).filter((use) => use.name === ROUTE).map((use) => use.input?.requestId))
  return requestsOf(messages).find((entry) => !routed.has(entry.id))
}
/** The words of the request the last commit_route was for, or null. */
function committedWords(messages: readonly Message[]) {
  const id = lastRouted(messages)
  return id ? requestsOf(messages).find((request) => request.id === id)?.words ?? null : null
}
/** The texts of the user's messages the last routed request came in with (its words, and what dsh and plugins added). */
function routedTexts(messages: readonly Message[]) {
  const id = lastRouted(messages)
  const at = messages.findIndex((message) => message.role === 'user' && rawTexts(message).some((text) => requestsIn(text).some((request) => request.id === id)))
  if (at < 0) return []
  let start = at, end = at
  while (start > 0 && messages[start - 1].role === 'user') start -= 1
  while (end + 1 < messages.length && messages[end + 1].role === 'user' && !partsOf(messages[end + 1]).some((part) => part.type === 'tool_result')) end += 1
  return messages.slice(start, end + 1).flatMap(textParts)
}
/** What the assistant last said in text, before this request. */
const lastSaid = (messages: readonly Message[]) => messages.filter((message) => message.role === 'assistant').flatMap(textParts).at(-1) ?? ''

/**
 * The main agent's routing step: the first request not routed yet, routed as the rules would handle it. A message
 * for a task first looks it up (list_background_tasks, a context tool), then routes with the task's id.
 */
function route(request: Request): Answer | null {
  if (!hasTool(request, ROUTE)) return null
  const messages = request.messages
  const pending = pendingRequest(messages)
  if (!pending) return null
  const { id, words } = pending
  const goal = (disposition: string) => [{ goal: words.slice(0, 200) || '请求', disposition }]
  const app = (operation: string, extra: Array<Action & { question: string }> = []) => commit(id, [...goal('app_operation'), ...extra.map((action) => ({ goal: action.question, disposition: 'needs_input' }))], [{ kind: 'app_action', operation }, ...extra])
  const tell = TELL.exec(words)
  if (tell) {
    const result = partsOf(messages.at(-1)).find((part) => part.type === 'tool_result')
    const use = toolUses(messages).at(-1)
    if (!result || use?.name !== 'list_background_tasks') return { tool: { name: 'list_background_tasks', input: {} } }
    const taskId = taskTitled(result, tell[1])
    return taskId ? commit(id, goal('update_task'), [{ kind: 'message', taskId, text: tell[2] }]) : commit(id, goal('answer'), [{ kind: 'reply', scope: '没找到任务' }])
  }
  const handOff = HAND_OFF.exec(words)
  // A task name of its own, as the tool asks of the model: the card is titled by it.
  if (handOff) return commit(id, goal('delegate'), [{ kind: 'start', title: handOff[1], brief: handOff[1] }])
  if (DELETE.test(words) || MAIL.some(([pattern]) => pattern.test(words))) return commit(id, goal('delegate'), [{ kind: 'start', title: words.split('\n')[0], brief: words }])
  if (REMEMBER.test(words)) return app('memory_remember')
  if (CONNECT.test(words)) return app('viva_mcp_add', THEN_ASK.test(words) ? [{ kind: 'clarify', question: CITY_QUESTION.question }] : [])
  if (FOLLOW.test(words)) return app('schedule_create')
  if (WEATHER.test(words)) return commit(id, goal('needs_input'), [{ kind: 'clarify', question: CITY_QUESTION.question }])
  return commit(id, goal('answer'), [{ kind: 'reply', scope: words.slice(0, 200) || '回答' }])
}

/**
 * Lets an integration scenario choose the main agent's app tool without emulating both routing steps.
 * The real router still records the action and enforces each grant. Task commands become route actions.
 */
export function routeFixtureTools<Raw extends object, Reply extends object>(decideFirst: (request: Raw) => Reply | null) {
  const actions = new Map<string, Reply>()
  return (raw: object): Reply | Answer | null => {
    const request = requestSchema.parse(raw)
    if (!hasTool(request, ROUTE)) return decideFirst(raw as Raw)
    const messages = request.messages
    const last = toolUses(messages).at(-1)
    if (last?.name === ROUTE && trailingToolResult(messages)) {
      const id = typeof last.input?.requestId === 'string' ? last.input.requestId : ''
      const action = actions.get(id)
      actions.delete(id)
      if (action) return action
    }
    const answer = decideFirst(raw as Raw)
    const pending = pendingRequest(messages)
    const parsed = answerSchema.safeParse(answer)
    if (!answer || !parsed.success || !parsed.data.tool || !pending) return answer
    const { name, input } = parsed.data.tool
    const goal = pending.words.slice(0, 200) || '请求'
    if (name === 'start_background_task') {
      return commit(pending.id, [{ goal, disposition: 'delegate' }], [{ kind: 'start', ...input }])
    }
    if (name === 'message_background_task') {
      return commit(pending.id, [{ goal, disposition: 'update_task' }], [{ kind: 'message', ...input }])
    }
    if (!APP_OPERATIONS.some(operation => operation === name)) return answer
    actions.set(pending.id, answer)
    return commit(pending.id, [{ goal, disposition: 'app_operation' }], [{ kind: 'app_action', operation: name }])
  }
}

/** Pick a deterministic scenario response; this never performs memory extraction or classification. */
export function decide(raw: object): Answer {
  const request = requestSchema.parse(raw)
  if (JSON.stringify(request.messages).includes(REVIEWER) || systemText(request).includes(REVIEWER)) return review(request)
  const routing = route(request)
  if (routing) return routing
  const messages = request.messages
  const last = messages[messages.length - 1]
  const use = toolUses(messages).at(-1)
  // Finish the granted app operation before handling an inbox report appended
  // after its route receipt. Ordinary completed routes may answer the report.
  const appRoute = use?.name === ROUTE && Array.isArray(use.input?.actions)
    && use.input.actions.some((action: unknown) => objectOf(action)?.kind === 'app_action')
  const result = appRoute ? trailingToolResult(messages) : partsOf(last).find((part) => part.type === 'tool_result')
  // Once a request is routed, the rules go on with its words, as if just asked.
  const routed = result && toolUses(messages).at(-1)?.name === ROUTE
  if (result && !routed) return afterTool(request, messages, result)
  const texts = routed ? routedTexts(messages) : trailingUserTexts(messages)
  const question = (routed ? committedWords(messages) : null) ?? questionOf(messages)
  // The city, answered in text to the question the main agent asked in text.
  if (routed && lastSaid(messages).endsWith(CITY_QUESTION.question)) return { text: `好的，按${question}来看：明天多云转晴。` }
  const remember = REMEMBER.exec(question)
  if (remember) {
    const text = remember[1].trim()
    return { tool: { name: 'memory_remember', input: { text } } }
  }
  const taskReport = TASK_REPORT.exec(question)
  if (taskReport) return { text: `已看过后台结果：${taskReport[1]}` }
  if (WEATHER.test(question)) return hasTool(request, 'ask_user_question') ? { tool: { name: 'ask_user_question', input: { questions: [CITY_QUESTION] } } } : { text: CITY_QUESTION.question }
  if (CONNECT.test(question)) return { tool: { name: 'viva_mcp_add', input: DEMO_SERVER } }
  if (FOLLOW.test(question)) return { tool: { name: 'schedule_create', input: followupProposal() } }
  const recall = RECALL.exec(question)
  if (recall) return { tool: { name: 'memory_recall', input: { query: recall[1].trim() } } }
  const removal = DELETE.exec(question)
  const shell = removal && (request.tools ?? []).find((tool) => SHELLS.includes(tool.name))
  if (shell) {
    const command = shell.name === 'pwsh' ? `Remove-Item -Recurse -Force ${removal[1]}` : `rm -rf ${removal[1]}`
    return { tool: { name: shell.name, input: { command, description: `删除 ${removal[1]}` } } }
  }
  const mail = MAIL.find(([pattern]) => pattern.test(question))
  const mailTool = mail && (request.tools ?? []).find((tool) => tool.name.endsWith(mail[1]))
  if (mailTool) return { tool: { name: mailTool.name, input: { to: '张三', body: question } } }
  return { text: `${backgroundOf(texts)}收到：「${question}」` }
}

function stream(res: ServerResponse, request: Request, index: number, decideFirst?: Decide | null) {
  const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  const answer = answerSchema.parse(decideFirst?.(request) ?? decide(request))
  if (answer.httpError) {
    res.writeHead(answer.httpError, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Simulated model failure' } }))
    return
  }
  // A test can hold the answer while another request is being dispatched.
  if (answer.waitFor) return answer.waitFor.then(() => {
    if (!res.destroyed) streamAnswer(res, request, index, answer, send)
  })
  // An answer may take a while (the showcase shows preparation at work).
  if (answer.delayMs) return setTimeout(() => streamAnswer(res, request, index, answer, send), answer.delayMs)
  return streamAnswer(res, request, index, answer, send)
}

function streamAnswer(res: ServerResponse, request: Request, index: number, answer: Answer, send: (type: string, data: Record<string, unknown>) => void) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  send('message_start', {
    message: { id: `msg_${index}`, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } },
  })
  if (answer.tool) {
    send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${index}`, name: answer.tool.name, input: {} } })
    send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(answer.tool.input) } })
  } else {
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer.text } })
  }
  send('content_block_stop', { index: 0 })
  send('message_delta', { delta: { stop_reason: answer.tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } })
  send('message_stop', {})
  res.end()
}

/** What the fake lists at `GET …/models`, Anthropic's shape: the smoke picks the first. */
export const LISTED_MODELS = Object.freeze([
  Object.freeze({ type: 'model', id: 'deepseek-chat', display_name: 'Fake Flash', max_input_tokens: 131072 }),
  Object.freeze({ type: 'model', id: 'fake-unpicked', display_name: 'Not picked' }),
])

/**
 * A fixed port supports smoke phases sharing a profile. Optional scenario
 * answers run before the common rules; null falls back to those rules.
 */
export function startFakeLlm({ port = 0, decideFirst = null }: { port?: number, decideFirst?: Decide | null } = {}) {
  const requests: Request[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer | string) => { body += chunk })
    req.on('end', () => {
      // The path, not the whole URL: SDK clients add a query (`/v1/messages?beta=true`).
      const { pathname } = new URL(req.url ?? "/", 'http://fake')
      // 获取可用模型 (model-discovery.ts): the model the smoke picks, and one it leaves.
      if (req.method === 'GET' && pathname.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: LISTED_MODELS }))
        return
      }
      if (req.method !== 'POST' || !pathname.endsWith('/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{}')
        return
      }
      try {
        const request = requestSchema.parse(JSON.parse(body))
        requests.push(request)
        stream(res, request, requests.length, decideFirst)
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } }))
      }
    })
  })
  return new Promise<{ url: string, requests: Request[], close(): Promise<void> }>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('Fake model must use a TCP listener'))
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())),
      })
    })
  })
}
