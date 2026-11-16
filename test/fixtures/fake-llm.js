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
 * - 「记住：X」 → calls memory_remember with X, and the names from KNOWN_NAMES in X as keywords;
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
 * - the memory plugin's background extractor gets the answers of `extract` below.
 */
import http from 'node:http'
import { currentTurnTextParts } from './model-user-text.ts'
import { requestsIn, withoutHeaders } from '../../src/shared/request-routing/header.ts'
import { APP_OPERATIONS } from '../../src/shared/request-routing/protocol.ts'

/** The fake has no language understanding; these are the names it can pick out as keywords. */
const KNOWN_NAMES = ['张三', '李四', '王五', '周报', '对账系统', '结算口径']
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
const MAIL = [[/^发邮件/, '__send_email'], [/^存草稿/, '__create_draft']]

const partsOf = (message) => (Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }])
const rawTexts = (message) => partsOf(message).filter((part) => part.type === 'text').map((part) => part.text)
/** The texts of a message, the app's request headers left out: the rules read the user's words. */
const textParts = (message) => rawTexts(message).map(withoutHeaders)

/** Says what background came with the question: the fixed layer, and how many pushed memories. */
function backgroundOf(texts) {
  const block = texts.find((text) => text.startsWith(CONTEXT_OPEN))
  if (!block) return ''
  const fixed = block.includes('【记忆规则】') ? '画像' : ''
  const pushed = block.split('\n').filter((line) => line.startsWith('- ') && line.endsWith('〕')).length
  const parts = [fixed, pushed ? `${pushed} 条相关记忆` : ''].filter(Boolean)
  return `我已经了解你的背景（${parts.join('、')}）。`
}

/** The text of the user's messages at the end of the request (this turn's), oldest first. */
function trailingUserTexts(messages) {
  let start = messages.length
  while (start > 0 && messages[start - 1].role === 'user') start -= 1
  return messages.slice(start).flatMap(textParts)
}

function currentWords(text) {
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
export const questionOf = (messages) => currentWords(currentTurnTextParts(trailingUserTexts(messages)).find((text) => !text.startsWith(CONTEXT_OPEN)) ?? '')

/** After a tool result the turn's last user message is that result: the words the user said come before it. */
export const lastWords = (messages) => currentWords(messages
  .filter((message) => message.role === 'user')
  .flatMap(textParts)
  .filter((text) => !text.startsWith(CONTEXT_OPEN))
  .at(-1) ?? '')

/**
 * What the user asked in this turn, for deciding after a tool result: the first words of the last run of user
 * messages with text. dsh may add messages of its own after the user's words (a fresh session's runtime context).
 */
const askedWords = (messages) => {
  const hasText = (message) => message.role === 'user' && textParts(message).length > 0
  let end = messages.length - 1
  while (end >= 0 && !hasText(messages[end])) end -= 1
  let start = end
  while (start > 0 && messages[start - 1].role === 'user') start -= 1
  return currentWords(messages.slice(start, end + 1).flatMap(textParts).find((text) => !text.startsWith(CONTEXT_OPEN)) ?? '')
}

function lastToolUse(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const use = partsOf(messages[i]).find((part) => part.type === 'tool_use')
    if (use) return use
  }
  return null
}

const resultText = (result) => (Array.isArray(result.content) ? result.content.map((part) => part.text ?? '').join('') : String(result.content ?? ''))

function memoryResult(result) {
  try {
    const parsed = JSON.parse(resultText(result))
    if (typeof parsed === 'string') return JSON.parse(parsed)
    return typeof parsed?.text === 'string' ? JSON.parse(parsed.text) : parsed
  } catch {
    return null
  }
}

/** What the user answered to the city question, or null when the tool came back without an answer. */
function cityFrom(result) {
  try {
    const answer = JSON.parse(resultText(result)).answers?.find((item) => item.id === CITY_QUESTION.id)
    return answer?.custom || answer?.selected?.[0] || null
  } catch {
    return null
  }
}

/** The task titled `title` in what list_background_tasks returned, or null. */
function taskTitled(result, title) {
  try {
    return JSON.parse(resultText(result)).tasks?.find((task) => task.title === title)?.taskId ?? null
  } catch {
    return null
  }
}

function afterTool(request, messages, result) {
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
  if (use?.name === 'memory_recall' && /(?:按记忆)?填写周报提交邮箱/.test(askedWords(messages))) {
    const resultValue = memoryResult(result)
    const alternative = [...(resultValue?.conflicts ?? []), ...(resultValue?.pendingChanges ?? [])].find(item => item.ref)
    if (alternative) return { tool: { name: 'memory_clarify', input: { ref: alternative.ref } } }
  }
  if (use?.name === 'memory_clarify') {
    const selected = memoryResult(result)?.answer?.answers?.[0]?.selected?.[0]
    return { text: selected ? `这次填 ${selected}` : '先保留提交地址，继续处理其他内容。' }
  }
  const output = JSON.stringify(result.content)
  if (use?.name !== 'memory_remember') return { text: `查到了：${output}` }
  const status = resultText(result)
  const saved = output.includes('已记住') || output.includes('之前已经记过') || status.includes('"status":"accepted"')
  return { text: saved ? `好的，我记住了：${use.input.text}`
    : status.includes('"status":"pending"') ? `已收到，稍后整理：${use.input.text}` : `没能记住：${output}` }
}

const systemText = (request) => (Array.isArray(request.system) ? request.system.map((part) => part.text ?? '').join('\n') : String(request.system ?? ''))
const EXTRACTOR = '记忆整理员'
const MEMORY_REVIEWER = '记忆变更复核员'
const MEMORY_QUESTION_REVIEWER = '记忆提问校验员'
const MEMORY_PROFILER = '从已核验的记忆和用户手填资料中，选择最多六条'
const modelInput = request => JSON.parse(textParts(request.messages.at(-1))[0])

/** Plays the structured extractor for a preference, an open fact or a proposed change. */
function extract(request) {
  const input = modelInput(request)
  const user = input.user
  const span = input.explicitlySaved ? input.spans[0] : { start: 0, end: user.length }
  const words = user.slice(span.start, span.end)
  const proposals = []
  const offset = (value, at = span.start) => {
    const start = user.indexOf(value, at)
    return { start, end: start + value.length }
  }
  const email = /^(?:(从现在起)[，,])?(我)(?:(唯一)的|的)(周报提交邮箱)(?:是\s+(\S+)|从\s+(\S+)\s+(改为|切换至|更新为)\s+(\S+))$/.exec(words)
  if (email) {
    const [, effective, subject, exclusive, relation, value, prior, action, next] = email
    const object = value ?? next
    const previous = (input.related ?? []).find(row => row.predicate === 'report_email'
      && (prior ? row.text.includes(prior) : !row.text.includes(object)))
    const reference = previous ? { id: previous.id, revision: previous.revision } : null
    proposals.push({ spans: [span], kind: 'fact', scope: 'user', modality: 'asserted', attribution: 'self', keywords: [relation],
      fact: { predicate: 'report_email', polarity: 'positive', subject: { kind: 'user', span: offset(subject) },
        relation: offset(relation), object: offset(object, action ? user.indexOf(action, span.start) : span.start) },
      ...(input.author === 'answer' ? { durableIntent: offset(effective ?? subject) } : {}),
      ...(action && reference ? { change: { kind: 'supersede', target: reference, temporal: { kind: 'current' },
        evidence: { action: offset(action), target: offset(prior), ...(effective ? { effective: offset(effective) } : {}) } } } : {}),
      ...(!action && exclusive && reference ? { independent: true, change: { kind: 'possible_conflict', target: reference,
        evidence: { action: offset(exclusive), target: offset(relation) } } } : {}) })
  }
  if (!email && input.explicitlySaved) proposals.push({ spans: input.spans, kind: 'fact', scope: 'user', modality: 'asserted', attribution: 'self',
    keywords: KNOWN_NAMES.filter(name => words.includes(name)), temporal: { kind: 'current' } })
  if (!input.explicitlySaved && /^以后/.test(words)) proposals.push({ spans: [span], kind: 'preference', scope: 'user', modality: 'asserted', attribution: 'self', keywords: [] })
  return { text: JSON.stringify({ proposals }) }
}

function reviewMemory(request) {
  const { user, proposals, related } = modelInput(request)
  return { text: JSON.stringify({ reviews: proposals.map(({ index, proposal, draft }) => {
    const { change } = proposal
    const old = change && related.find(row => row.id === change.target.id && row.revision === change.target.revision)
    const confirmed = draft.purpose === 'answer-intent' ? user.startsWith('从现在起')
      : old?.predicate === 'report_email' && user.includes('周报提交邮箱')
    return { index, verdict: confirmed ? 'confirmed' : 'rejected', draftId: draft.id }
  }) }) }
}

function reviewMemoryQuestion(request) {
  const { snapshotId, questions } = modelInput(request)
  return { text: JSON.stringify({ snapshotId, verdict: questions.some(({ question }) => /平时把例行汇报交到哪里|两个周报提交邮箱要用哪一个/u.test(question))
    ? 'related' : 'unrelated' }) }
}

/** dsh's Auto review asks the model about each pending step; its request starts with this section. */
const REVIEWER = 'REVIEW_POLICY'
/** 「删掉 X」: removes X with the shell, which the fake reviewer will not allow by itself. */
const DELETE = /^删掉\s*(\S+)/
const SHELLS = ['bash', 'pwsh']

/** Plays the Auto reviewer: removing anything goes to the user, everything else is let through. */
function review(request) {
  const removes = /rm -rf|Remove-Item/.test(JSON.stringify(request.messages))
  return { text: JSON.stringify(removes ? { risk: 'medium', decision: 'deny', reason: '要删除原有的文件' } : { risk: 'low', decision: 'allow' }) }
}

const ROUTE = 'commit_route'
const hasTool = (request, name) => (request.tools ?? []).some((tool) => tool.name === name)
/** A routing decision; one handing work over says so to the user in its notice, as a main agent there does. */
const commit = (requestId, goals, actions) => {
  const handed = actions.find((action) => action.kind === 'start' || action.kind === 'message' || action.kind === 'stop')
  const notice = handed?.kind === 'start' ? `已经交给后台：${handed.brief}` : handed?.kind === 'message' ? `已经转告：${handed.text}` : handed ? '已经停下那个任务' : undefined
  return { tool: { name: ROUTE, input: { requestId, ...(notice ? { notice } : {}), goals, actions } } }
}
const toolUses = (messages) => messages.flatMap((message) => partsOf(message).filter((part) => part.type === 'tool_use'))
/** The requests the app put in the conversation, oldest first, each with its words. */
const requestsOf = (messages) => messages.filter((message) => message.role === 'user').flatMap(rawTexts).flatMap(requestsIn)
  .map((request) => ({ id: request.id, words: currentWords(request.words).trim() }))
const lastRouted = (messages) => toolUses(messages).filter((use) => use.name === ROUTE).at(-1)?.input?.requestId ?? null
const pendingRequest = (messages) => {
  const routed = new Set(toolUses(messages).filter((use) => use.name === ROUTE).map((use) => use.input?.requestId))
  return requestsOf(messages).find((entry) => !routed.has(entry.id))
}
/** The words of the request the last commit_route was for, or null. */
function committedWords(messages) {
  const id = lastRouted(messages)
  return id ? requestsOf(messages).find((request) => request.id === id)?.words ?? null : null
}
/** The texts of the user's messages the last routed request came in with (its words, and what dsh and plugins added). */
function routedTexts(messages) {
  const id = lastRouted(messages)
  const at = messages.findIndex((message) => message.role === 'user' && rawTexts(message).some((text) => requestsIn(text).some((request) => request.id === id)))
  if (at < 0) return []
  let start = at, end = at
  while (start > 0 && messages[start - 1].role === 'user') start -= 1
  while (end + 1 < messages.length && messages[end + 1].role === 'user' && !partsOf(messages[end + 1]).some((part) => part.type === 'tool_result')) end += 1
  return messages.slice(start, end + 1).flatMap(textParts)
}
/** What the assistant last said in text, before this request. */
const lastSaid = (messages) => messages.filter((message) => message.role === 'assistant').flatMap(textParts).at(-1) ?? ''

/**
 * The main agent's routing step: the first request not routed yet, routed as the rules would handle it. A message
 * for a task first looks it up (list_background_tasks, a context tool), then routes with the task's id.
 */
function route(request) {
  if (!hasTool(request, ROUTE)) return null
  const messages = request.messages
  const pending = pendingRequest(messages)
  if (!pending) return null
  const { id, words } = pending
  const goal = (disposition) => [{ goal: words.slice(0, 200) || '请求', disposition }]
  const app = (operation, extra = []) => commit(id, [...goal('app_operation'), ...extra.map((action) => ({ goal: action.question, disposition: 'needs_input' }))], [{ kind: 'app_action', operation }, ...extra])
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
 * @template {object} Request, Answer
 * @param {(request: Request) => Answer | null} decideFirst
 */
export function routeFixtureTools(decideFirst) {
  const actions = new Map()
  return (/** @type {Request} */ request) => {
    if (!hasTool(request, ROUTE)) return decideFirst(request)
    const messages = request.messages
    const last = toolUses(messages).at(-1)
    if (last?.name === ROUTE && partsOf(messages.at(-1)).some(part => part.type === 'tool_result')) {
      const action = actions.get(last.input?.requestId)
      actions.delete(last.input?.requestId)
      if (action) return action
    }
    const answer = decideFirst(request)
    const pending = pendingRequest(messages)
    if (!answer?.tool || !pending) return answer
    const { name, input } = answer.tool
    const goal = pending.words.slice(0, 200) || '请求'
    if (name === 'start_background_task') {
      return commit(pending.id, [{ goal, disposition: 'delegate' }], [{ kind: 'start', ...input }])
    }
    if (name === 'message_background_task') {
      return commit(pending.id, [{ goal, disposition: 'update_task' }], [{ kind: 'message', ...input }])
    }
    if (!APP_OPERATIONS.includes(name)) return answer
    actions.set(pending.id, answer)
    return commit(pending.id, [{ goal, disposition: 'app_operation' }], [{ kind: 'app_action', operation: name }])
  }
}

/** @returns {{ tool: { name: string, input: object } } | { text: string }} */
export function decide(request) {
  if (systemText(request).includes(MEMORY_PROFILER)) {
    const { items } = modelInput(request)
    return { text: JSON.stringify({ refs: items.slice(0, 6).map(({ ref }) => ref) }) }
  }
  if (systemText(request).includes(MEMORY_QUESTION_REVIEWER)) return reviewMemoryQuestion(request)
  if (JSON.stringify(request.messages).includes(REVIEWER) || systemText(request).includes(REVIEWER)) return review(request)
  if (systemText(request).includes(MEMORY_REVIEWER)) return reviewMemory(request)
  if (systemText(request).includes(EXTRACTOR)) return extract(request)
  const routing = route(request)
  if (routing) return routing
  const messages = request.messages
  const last = messages[messages.length - 1]
  const result = partsOf(last).find((part) => part.type === 'tool_result')
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
    const keywords = KNOWN_NAMES.filter((name) => text.includes(name)).sort((a, b) => text.indexOf(a) - text.indexOf(b))
    return { tool: { name: 'memory_remember', input: { text, keywords } } }
  }
  const taskReport = TASK_REPORT.exec(question)
  if (taskReport) return { text: `已看过后台结果：${taskReport[1]}` }
  if (WEATHER.test(question)) return hasTool(request, 'ask_user_question') ? { tool: { name: 'ask_user_question', input: { questions: [CITY_QUESTION] } } } : { text: CITY_QUESTION.question }
  if (/填写周报提交邮箱/.test(question)) return { tool: { name: 'memory_recall', input: { query: '周报提交邮箱' } } }
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

function stream(res, request, index, decideFirst) {
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  const answer = decideFirst?.(request) ?? decide(request)
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

function streamAnswer(res, request, index, answer, send) {
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
 * @param {{ port?: number, decideFirst?: (request: object) => object | null }} [options] a fixed port, for smoke
 *   phases that share a profile (its models keep the URL); decideFirst, answers tried before the rules above
 *   (showcase-llm.js), null to fall back to them
 * @returns {Promise<{ url: string, requests: object[], close: () => Promise<void> }>}
 */
export function startFakeLlm({ port = 0, decideFirst = null } = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      // The path, not the whole URL: SDK clients add a query (`/v1/messages?beta=true`).
      const { pathname } = new URL(req.url, 'http://fake')
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
        const request = JSON.parse(body)
        requests.push(request)
        stream(res, request, requests.length, decideFirst)
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: err.message } }))
      }
    })
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((done) => server.close(() => done())),
  })))
}
