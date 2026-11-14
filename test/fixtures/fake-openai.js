import http from 'node:http'
import { requestsIn } from '../../src/shared/request-routing/header.ts'

/**
 * A local stand-in for an OpenAI-compatible endpoint (Chat Completions, streamed), for providers the user
 * adds besides DeepSeek. It answers every request with one fixed line and keeps what it was sent, with the
 * authorization header, in `requests`. Offered commit_route (the main conversation, plugins/routing) for a request
 * the user just made, it first routes it as an answer, as a model there does.
 */
export const OPENAI_REPLY = '来自 OpenAI 兼容接口的回答'

const textOf = (content) => (Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : String(content ?? ''))

/** The request to route: one the user's messages name and no commit_route was made for yet, when the tool is offered. */
function toRoute(body) {
  if (!(body.tools ?? []).some((tool) => tool.function?.name === 'commit_route')) return null
  const messages = body.messages ?? []
  const routed = messages.flatMap((message) => message.tool_calls ?? []).filter((call) => call.function?.name === 'commit_route')
    .map((call) => JSON.parse(call.function.arguments || '{}').requestId)
  return messages.filter((message) => message.role === 'user').flatMap((message) => requestsIn(textOf(message.content)))
    .find((request) => !routed.includes(request.id)) ?? null
}

function stream(res, model, delta, finish) {
  const chunk = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model, choices, ...extra })}\n\n`)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }])
  chunk([{ index: 0, delta, finish_reason: null }])
  chunk([{ index: 0, delta: {}, finish_reason: finish }])
  chunk([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  res.end('data: [DONE]\n\n')
}

/**
 * The main agent's routing step for a Chat Completions request, as the delta of a streamed tool call; null when there
 * is nothing to route (a task, or the request already routed). Other OpenAI-compatible stand-ins answer with it too.
 */
export function routeDelta(body) {
  const request = toRoute(body)
  if (!request) return null
  const route = { requestId: request.id, goals: [{ goal: request.words.trim() || '回答', disposition: 'answer' }], actions: [{ kind: 'reply', scope: '回答' }] }
  return { tool_calls: [{ index: 0, id: 'call_route', type: 'function', function: { name: 'commit_route', arguments: JSON.stringify(route) } }] }
}

function answer(res, body) {
  const route = routeDelta(body)
  return route ? stream(res, body.model, route, 'tool_calls') : stream(res, body.model, { content: OPENAI_REPLY }, 'stop')
}

/** @returns {Promise<{ url: string, requests: Array<{ path: string, authorization: string, body: object }>, close: () => Promise<void> }>} */
export function startFakeOpenAi() {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const { pathname } = new URL(req.url, 'http://fake')
      if (req.method !== 'POST' || !pathname.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{}')
        return
      }
      const request = { path: pathname, authorization: req.headers.authorization ?? '', body: JSON.parse(body) }
      requests.push(request)
      answer(res, request.body)
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((done) => server.close(done)),
  })))
}
