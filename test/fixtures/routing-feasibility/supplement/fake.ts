/** Scriptable stand-in for the DeepSeek Messages API: several blocks per step, chunked text with delays. */
import http from 'node:http'

export type FakeBlock =
  | { text: string, chunks?: number, chunkDelayMs?: number }
  | { tool: { name: string, input: Record<string, unknown> } }
export interface FakeAnswer { blocks: FakeBlock[], delayMs?: number }
export type FakeRequest = { tools?: Array<{ name: string }>, messages?: unknown[], system?: unknown }
export type Decide = (request: FakeRequest, index: number) => FakeAnswer

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function streamAnswer(res: http.ServerResponse, request: FakeRequest & { model?: string }, index: number, answer: FakeAnswer) {
  const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  if (answer.delayMs) await wait(answer.delayMs)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  send('message_start', { message: { id: `msg_${index}`, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
  let hasTool = false
  for (const [i, block] of answer.blocks.entries()) {
    if ('tool' in block) {
      hasTool = true
      send('content_block_start', { index: i, content_block: { type: 'tool_use', id: `toolu_${index}_${i}`, name: block.tool.name, input: {} } })
      send('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.tool.input) } })
    } else {
      send('content_block_start', { index: i, content_block: { type: 'text', text: '' } })
      const parts = Math.max(1, block.chunks ?? 1)
      const size = Math.ceil(block.text.length / parts)
      for (let p = 0; p < parts; p++) {
        send('content_block_delta', { index: i, delta: { type: 'text_delta', text: block.text.slice(p * size, (p + 1) * size) } })
        if (block.chunkDelayMs) await wait(block.chunkDelayMs)
      }
    }
    send('content_block_stop', { index: i })
  }
  send('message_delta', { delta: { stop_reason: hasTool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } })
  send('message_stop', {})
  res.end()
}

export function startScriptedLlm(decide: Decide): Promise<{ url: string, requests: FakeRequest[], close: () => Promise<void> }> {
  const requests: FakeRequest[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const { pathname } = new URL(req.url ?? '/', 'http://fake')
      if (req.method === 'GET' && pathname.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ type: 'model', id: 'deepseek-flash', display_name: 'Fake' }] }))
        return
      }
      if (req.method !== 'POST' || !pathname.endsWith('/messages')) { res.writeHead(404).end('{}'); return }
      try {
        const request = JSON.parse(body) as FakeRequest
        requests.push(request)
        streamAnswer(res, request, requests.length, decide(request, requests.length)).catch(() => res.end())
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: error instanceof Error ? error.message : 'bad request' } }))
      }
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise(done => server.close(() => done())) })
  }))
}
