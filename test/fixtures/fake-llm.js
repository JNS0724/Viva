/**
 * A stand-in for the DeepSeek Messages API, for running the real dsh (and the memory plugin) without a key:
 * point `DEEPSEEK_BASE_URL` at `url`. Every request is kept in `requests` so tests can see exactly what the
 * model was given. Its "model" is a few fixed rules on the user's latest words:
 *
 * - 「记住：X」 → calls memory_remember with X, and the names from KNOWN_NAMES in X as keywords;
 * - 「查一下 X」 → calls memory_recall with X;
 * - 「…明天…天气…」 → asks which city with ask_user_question, then answers for the city it was told;
 * - 「…接入演示服务…」 → sets up DEMO_SERVER with viva_mcp_add (its key named, never given), then says the result;
 * - 「把全部…」 → offers the background with viva_offer_background, then goes on (「开始整理」, or, asked to
 *   接入演示服务 too, to that);
 * - after a tool result → says what the tool did;
 * - anything else → 「收到：…」, prefixed with what background it was given;
 * - the memory plugin's background extractor gets the answers of `extract` below.
 */
import http from 'node:http'

/** The fake has no language understanding; these are the names it can pick out as keywords. */
const KNOWN_NAMES = ['张三', '李四', '王五', '周报', '对账系统', '结算口径']
const REMEMBER = /记住[:：]\s*(.+)$/s
const RECALL = /查一下\s*(.+)$/s
const WEATHER = /明天.*天气/
const CONNECT = /接入演示服务/
/** 「把全部…」: a job that will take long, which the fake offers the background first (viva_offer_background). */
const BIG_JOB = /^把全部/
/** What the fake asks to set up: a local server whose key the user types in the window. */
export const DEMO_SERVER = Object.freeze({ name: 'demo', command: 'node', args: ['demo-mcp.js'], secrets: ['DEMO_TOKEN'] })
export const CITY_QUESTION = Object.freeze({
  id: 'city', question: '你想看哪个城市的天气？', header: '城市', options: [{ label: '上海' }, { label: '北京' }],
})
const CONTEXT_OPEN = '<about-user>'
/** 「发邮件…」 / 「存草稿…」 call the MCP tool whose name ends so; dsh prefixes it with the hashed server name. */
const MAIL = [[/^发邮件/, '__send_email'], [/^存草稿/, '__create_draft']]

const partsOf = (message) => (Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }])
const textParts = (message) => partsOf(message).filter((part) => part.type === 'text').map((part) => part.text)

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

/**
 * The user's words: the first text of the turn's user messages that is not the memory block. What dsh and the
 * plugins add (the block, notices) comes after them, in the same message or, in a forked session, in others.
 */
const questionOf = (messages) => trailingUserTexts(messages).find((text) => !text.startsWith(CONTEXT_OPEN)) ?? ''

/** After a tool result the turn's last user message is that result: the words the user said come before it. */
const lastWords = (messages) => messages
  .filter((message) => message.role === 'user')
  .flatMap(textParts)
  .filter((text) => !text.startsWith(CONTEXT_OPEN))
  .at(-1) ?? ''

function lastToolUse(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const use = partsOf(messages[i]).find((part) => part.type === 'tool_use')
    if (use) return use
  }
  return null
}

const resultText = (result) => (Array.isArray(result.content) ? result.content.map((part) => part.text ?? '').join('') : String(result.content ?? ''))

/** What the user answered to the city question, or null when the tool came back without an answer. */
function cityFrom(result) {
  try {
    const answer = JSON.parse(resultText(result)).answers?.find((item) => item.id === CITY_QUESTION.id)
    return answer?.custom || answer?.selected?.[0] || null
  } catch {
    return null
  }
}

function afterTool(messages, result) {
  const use = lastToolUse(messages)
  if (use?.name === 'ask_user_question') {
    const city = cityFrom(result)
    return { text: city ? `好的，按${city}来看：明天多云转晴。` : `没问到城市：${resultText(result)}` }
  }
  if (use?.name === 'viva_mcp_add') return { text: `配置结果：${resultText(result)}` }
  if (use?.name === 'viva_offer_background') {
    // Asked to set up the demo service too, it goes on to that, whose approval holds the turn open.
    if (CONNECT.test(lastWords(messages))) return { tool: { name: 'viva_mcp_add', input: DEMO_SERVER } }
    return { text: `开始整理。（${resultText(result)}）` }
  }
  const output = JSON.stringify(result.content)
  if (use?.name !== 'memory_remember') return { text: `查到了：${output}` }
  const saved = output.includes('已记住') || output.includes('之前已经记过')
  return { text: saved ? `好的，我记住了：${use.input.text}` : `没能记住：${output}` }
}

const systemText = (request) => (Array.isArray(request.system) ? request.system.map((part) => part.text ?? '').join('\n') : String(request.system ?? ''))
const EXTRACTOR = '记忆整理员'
const NEW_MANAGER = /现在(?:我的)?(?:直属)?上级是(\S{2,4}?)[，。,.]?$/

/**
 * Plays the background extractor (plugins/memory/lib/extract.js): 「以后…」 becomes a preference, a new
 * manager replaces the agent's memory about the old one, and a city the user answered with is kept.
 * Anything else: no change.
 */
function extract(request) {
  const input = JSON.parse(textParts(request.messages[request.messages.length - 1])[0])
  const add = []
  if (/^以后/.test(input.user)) add.push({ text: input.user.replace(/^以后/, '').replace(/[，,]/, ''), kind: 'preference', keywords: [] })
  const city = input.answers?.find((item) => item.question.includes('城市'))?.answer
  if (city) add.push({ text: `用户在${city}`, kind: 'fact', keywords: [city] })
  const manager = NEW_MANAGER.exec(input.user)
  if (manager) {
    const old = input.memories.find((memory) => memory.text.includes('上级'))
    add.push({ text: `直属上级是${manager[1]}`, kind: 'person', keywords: [manager[1]], replaces: old?.id ?? null })
  }
  return { text: JSON.stringify({ add, invalidate: [] }) }
}

const SYNTHESIZER = '画像整理员'
const SYNTHESIS_HEADINGS = [['role', '身份与职责'], ['person', '常打交道的人'], ['project', '在推进的事'], ['preference', '偏好']]

/** Plays the profile synthesis (plugins/memory/lib/synthesize.js): the memories, grouped under the agreed headings. */
function synthesize(request) {
  const input = JSON.parse(textParts(request.messages[request.messages.length - 1])[0])
  const text = SYNTHESIS_HEADINGS
    .map(([kind, heading]) => [heading, input.memories.filter((memory) => memory.kind === kind)])
    .filter(([, memories]) => memories.length)
    .flatMap(([heading, memories]) => [`【${heading}】`, ...memories.map((memory) => `- ${memory.text}`)])
    .join('\n')
  return { text }
}

/** @returns {{ tool: { name: string, input: object } } | { text: string }} */
export function decide(request) {
  if (systemText(request).includes(EXTRACTOR)) return extract(request)
  if (systemText(request).includes(SYNTHESIZER)) return synthesize(request)
  const messages = request.messages
  const last = messages[messages.length - 1]
  const result = partsOf(last).find((part) => part.type === 'tool_result')
  if (result) return afterTool(messages, result)
  const texts = trailingUserTexts(messages)
  const question = questionOf(messages)
  const remember = REMEMBER.exec(question)
  if (remember) {
    const text = remember[1].trim()
    const keywords = KNOWN_NAMES.filter((name) => text.includes(name)).sort((a, b) => text.indexOf(a) - text.indexOf(b))
    return { tool: { name: 'memory_remember', input: { text, keywords } } }
  }
  if (WEATHER.test(question)) return { tool: { name: 'ask_user_question', input: { questions: [CITY_QUESTION] } } }
  if (BIG_JOB.test(question)) return { tool: { name: 'viva_offer_background', input: { why: '要逐个读完所有文档' } } }
  if (CONNECT.test(question)) return { tool: { name: 'viva_mcp_add', input: DEMO_SERVER } }
  const recall = RECALL.exec(question)
  if (recall) return { tool: { name: 'memory_recall', input: { query: recall[1].trim() } } }
  const mail = MAIL.find(([pattern]) => pattern.test(question))
  const mailTool = mail && (request.tools ?? []).find((tool) => tool.name.endsWith(mail[1]))
  if (mailTool) return { tool: { name: mailTool.name, input: { to: '张三', body: question } } }
  return { text: `${backgroundOf(texts)}收到：「${question}」` }
}

function stream(res, request, index) {
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  const answer = decide(request)
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

/** @returns {Promise<{ url: string, requests: object[], close: () => Promise<void> }>} */
export function startFakeLlm() {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      // The path, not the whole URL: SDK clients add a query (`/v1/messages?beta=true`).
      if (req.method !== 'POST' || !new URL(req.url, 'http://fake').pathname.endsWith('/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{}')
        return
      }
      try {
        const request = JSON.parse(body)
        requests.push(request)
        stream(res, request, requests.length)
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: err.message } }))
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((done) => server.close(() => done())),
  })))
}
