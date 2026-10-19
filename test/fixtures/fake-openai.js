import http from 'node:http'

/**
 * A local stand-in for an OpenAI-compatible endpoint (Chat Completions, streamed), for providers the user
 * adds besides DeepSeek. It answers every request with one fixed line and keeps what it was sent, with the
 * authorization header, in `requests`.
 */
export const OPENAI_REPLY = '来自 OpenAI 兼容接口的回答'

function streamReply(res, model) {
  const chunk = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model, choices, ...extra })}\n\n`)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }])
  chunk([{ index: 0, delta: { content: OPENAI_REPLY }, finish_reason: null }])
  chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])
  chunk([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  res.end('data: [DONE]\n\n')
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
      streamReply(res, request.body.model)
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((done) => server.close(done)),
  })))
}
