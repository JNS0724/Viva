import type { TestContext } from 'node:test'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { createEnvelope } from '../../src/backend/envelope.ts'
import type { StoredEvent } from '../../src/backend/event-core.ts'
import { createRemoteHost } from '../../src/backend/remote-host.ts'
import { type ChannelListener, createRpcServer } from '../../src/backend/rpc-server.ts'
import type { StartMessage } from '../../src/backend/wire.ts'
import { connect } from '../../src/shell/backend-client.ts'

export const TOKEN = 'a'.repeat(64)
export const START: Pick<StartMessage, 'paths' | 'packaged' | 'automation' | 'locale' | 'mirror'> = {
  paths: { userData: '/tmp/u', documents: '/tmp/d', home: '/tmp/h' },
  packaged: false, automation: true, locale: 'zh-CN',
  mirror: { inFront: false, idleSeconds: 0, shellSettings: { shortcut: null, openAtLogin: { available: true } } },
}

/** A backend's HTTP side with the given channels, and the shell's connection to it. */
export async function backendWith(t: TestContext, channels: Record<string, ChannelListener>, stored: StoredEvent[] = []) {
  const remote = createRemoteHost({ start: START, secrets: createEnvelope({ key: randomBytes(32) }) })
  const server = createRpcServer({
    token: TOKEN,
    channels: new Map(Object.entries(channels).map(([channel, listener]) => [channel, { kind: 'handle' as const, listener }])),
    controls: { mirror: (update) => remote.mirror(update as never), inFront: () => remote.host.window.inFront() },
    remote,
    since: (seq) => stored.filter((event) => event.seq > seq),
    image: (url) => new Response(url.endsWith('ok.png') ? new Uint8Array([1, 2, 3]) : null, { status: url.endsWith('ok.png') ? 200 : 404, headers: { 'content-type': 'image/png' } }),
  })
  const port = await server.listen()
  t.after(() => server.close())
  return { remote, port, connection: connect({ port, token: TOKEN }) }
}

export function post(port: number, path: string, { headers = {}, body = '' }: { headers?: Record<string, string>, body?: string } = {}): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

