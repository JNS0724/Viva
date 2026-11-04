import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { createEnvelope } from '../src/backend/envelope.ts'
import type { StoredEvent } from '../src/backend/event-core.ts'
import { createRemoteHost } from '../src/backend/remote-host.ts'
import { type ChannelListener, createRpcServer } from '../src/backend/rpc-server.ts'
import { decodeValue, encodeValue, type HostCall, SEQ_HEADER, sseReader, type StartMessage } from '../src/backend/wire.ts'
import { connect } from '../src/shell/backend-client.ts'

const TOKEN = 'a'.repeat(64)
const START: Pick<StartMessage, 'paths' | 'packaged' | 'automation' | 'locale' | 'mirror'> = {
  paths: { userData: '/tmp/u', documents: '/tmp/d', home: '/tmp/h' },
  packaged: false, automation: true, locale: 'zh-CN',
  mirror: { inFront: false, idleSeconds: 0, shellSettings: { shortcut: null, openAtLogin: { available: true } } },
}

/** A backend's HTTP side with the given channels, and the shell's connection to it. */
async function backendWith(t: TestContext, channels: Record<string, ChannelListener>, stored: StoredEvent[] = []) {
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

function post(port: number, path: string, { headers = {}, body = '' }: { headers?: Record<string, string>, body?: string } = {}): Promise<{ status: number, body: string }> {
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

test('a page\'s call reaches its channel with its arguments, bytes uploaded first, and the answer or error comes back', async (t) => {
  const { connection } = await backendWith(t, {
    'history:list': (_event, limit) => ({ limit, items: ['a'] }),
    'images:keep': (_event, bytes) => ({ isBuffer: Buffer.isBuffer(bytes), length: (bytes as Buffer).length }),
    'agent:cancel': () => { throw new Error('nothing to cancel') },
  })
  assert.deepEqual(await connection.rpc('history:list', [5]), { limit: 5, items: ['a'] })
  assert.deepEqual(await connection.rpc('history:list', [undefined]), { items: ['a'] }, 'an argument left out stays left out, not null')
  assert.deepEqual(await connection.rpc('images:keep', [new Uint8Array(70_000)]), { isBuffer: true, length: 70_000 })
  await assert.rejects(connection.rpc('agent:cancel', []), /^Error: nothing to cancel$/)
  await assert.rejects(connection.rpc('nope:never', []), /no channel nope:never/)
  const picture = await connection.image('viva-image://img/ok.png')
  assert.deepEqual([picture.status, [...new Uint8Array(await picture.arrayBuffer())]], [200, [1, 2, 3]])
  assert.equal((await connection.image('viva-image://img/gone.png')).status, 404)
})

test('calls start in the order the shell made them, whatever order their bodies arrive in', async (t) => {
  const order: unknown[] = []
  const { port } = await backendWith(t, { 'history:save': (_event, rows) => { order.push(rows) } })
  const auth = { authorization: `Bearer ${TOKEN}` }
  const second = post(port, '/rpc/history:save', { headers: { ...auth, [SEQ_HEADER]: '2' }, body: JSON.stringify({ args: [['second']] }) })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(order, [], 'the second waits for the first')
  const bad = await post(port, '/rpc/history:save', { headers: { ...auth, [SEQ_HEADER]: '1' }, body: '{ broken' })
  assert.equal(bad.status, 400)
  assert.equal((await second).status, 200)
  assert.deepEqual(order, [['second']], 'a call that could not start gives up its turn, and the next goes')
})

test('a call after the connection sat idle goes through (the server keeps its sockets)', async (t) => {
  const { connection } = await backendWith(t, { 'agent:info': () => 'info' })
  assert.equal(await connection.rpc('agent:info', []), 'info')
  await new Promise((resolve) => setTimeout(resolve, 5_500))
  assert.equal(await connection.rpc('agent:info', []), 'info')
})

test('a call whose turn never comes holds up the next ones only for a while', async (t) => {
  const { port } = await backendWith(t, { 'agent:info': () => 'info' })
  const started = Date.now()
  const late = await post(port, '/rpc/agent:info', { headers: { authorization: `Bearer ${TOKEN}`, [SEQ_HEADER]: '2' } })
  assert.deepEqual(JSON.parse(late.body), { ok: true, value: 'info', mark: 0 })
  assert.ok(Date.now() - started >= 4_900, 'it waited for number 1 first')
})

test('only the token and the server\'s own host get in', async (t) => {
  const { port } = await backendWith(t, { 'agent:info': () => 'info' })
  assert.equal((await post(port, '/rpc/agent:info')).status, 401)
  assert.equal((await post(port, '/rpc/agent:info', { headers: { authorization: `Bearer ${'b'.repeat(64)}` } })).status, 401)
  assert.equal((await post(port, '/rpc/agent:info', { headers: { authorization: `Bearer ${TOKEN}`, host: `localhost:${port}` } })).status, 403)
  const ok = await post(port, '/rpc/agent:info', { headers: { authorization: `Bearer ${TOKEN}` } })
  assert.deepEqual([ok.status, JSON.parse(ok.body)], [200, { ok: true, value: 'info', mark: 0 }])
})

test('what the backend asks of the desktop waits for the shell, keeps its order, and gets the shell\'s answers', async (t) => {
  const stored: StoredEvent[] = [{ seq: 1, at: 1, kind: 'signal.system.woke', data: {} }, { seq: 2, at: 2, kind: 'followup.added', data: { id: 'f1' } }]
  const { remote, connection } = await backendWith(t, {}, stored)
  remote.host.window.send({ type: 'ready', seq: 0 })
  const folder = remote.host.dialogs.chooseFolder({ title: 'Pick' })
  remote.host.window.send({ type: 'update', seq: 0 })
  // Its handler goes on now: the refusal can come before the folder's answer is awaited.
  const refused = assert.rejects(remote.host.shell.openPath('/nowhere'), /no such folder/)
  let opened = -1
  remote.host.notify({ kind: 'ready', title: 'T', body: 'B' } as never, (afterMs) => { opened = afterMs })

  const seen: HostCall[] = []
  const replayed: StoredEvent[] = []
  await new Promise<void>((resolve) => {
    const stop = connection.listen({
      since: 0,
      stored: (event) => replayed.push(event),
      host: (call) => {
        seen.push(call)
        if (call.method === 'dialogs.chooseFolder') return '/picked'
        if (call.method === 'shell.openPath') throw new Error('no such folder')
        if (call.method === 'notify') void connection.callback(call.args[1] as number, [1500]).then(() => { stop(); resolve() })
        return undefined
      },
      ended: () => {},
    })
  })
  assert.equal(await folder, '/picked')
  await refused
  assert.deepEqual(seen.map((call) => call.method), ['window.send', 'dialogs.chooseFolder', 'window.send', 'shell.openPath', 'notify'], 'what waited, in order')
  assert.deepEqual(replayed.map((event) => event.seq), [1, 2], 'listening again: the stored events after the number, first')
  assert.equal(opened, 1500)
})

test('an answer reaches the page only after what the backend pushed before it, even when the push comes late', async (t) => {
  const remote = createRemoteHost({ start: START, secrets: createEnvelope({ key: randomBytes(32) }) })
  // The stream is slow: each host call reaches the shell 200 ms after the backend made it.
  const late = { ...remote, listen: (listener: (call: HostCall) => void) => remote.listen((call) => { setTimeout(() => listener(call), 200) }) }
  const server = createRpcServer({
    token: TOKEN,
    channels: new Map([['history:save', { kind: 'handle' as const, listener: () => { remote.host.window.send({ type: 'history_saved', seq: 0 }); return 'saved' } }]]),
    controls: {}, remote: late, since: () => [], image: () => new Response(null, { status: 404 }),
  })
  const port = await server.listen()
  t.after(() => server.close())
  const connection = connect({ port, token: TOKEN })
  const pushed: string[] = []
  const stop = connection.listen({ host: (call) => { pushed.push(String((call.args[0] as { type: string }).type)) }, ended: () => {} })
  t.after(stop)
  const started = Date.now()
  assert.equal(await connection.rpc('history:save', [[]]), 'saved')
  assert.deepEqual(pushed, ['history_saved'], 'the push came first')
  assert.ok(Date.now() - started >= 150, 'the answer waited for it')
})

test('the mirror is what the backend reads without waiting', async (t) => {
  const { connection } = await backendWith(t, {})
  assert.equal(await connection.control('inFront'), false)
  await connection.control('mirror', { inFront: true })
  assert.equal(await connection.control('inFront'), true)
})

test('SSE survives chunks cut anywhere, and bytes survive JSON both ways', () => {
  const got: Array<[string, unknown]> = []
  const read = sseReader((event, data) => got.push([event, data]))
  const text = 'event: host\ndata: {"id":null,"method":"window.send","args":[{"text":"你好"}]}\n\n: alive\n\nevent: stored\ndata: {"seq":3}\n\n'
  for (let i = 0; i < text.length; i += 7) read(text.slice(i, i + 7))
  assert.deepEqual(got, [['host', { id: null, method: 'window.send', args: [{ text: '你好' }] }], ['stored', { seq: 3 }]])
  const value = { picture: new Uint8Array([0, 255, 7]), list: [new Uint8Array([1])], plain: 'x' }
  const back = decodeValue(JSON.parse(JSON.stringify(encodeValue(value)))) as typeof value
  assert.deepEqual([[...back.picture], [...back.list[0]], back.plain], [[0, 255, 7], [1], 'x'])
})
