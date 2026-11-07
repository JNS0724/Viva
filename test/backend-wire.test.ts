import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createEnvelope } from '../src/backend/envelope.ts'
import type { StoredEvent } from '../src/backend/event-core.ts'
import { createRemoteHost } from '../src/backend/remote-host.ts'
import { createRpcServer } from '../src/backend/rpc-server.ts'
import { decodeValue, encodeValue, type HostCall, SEQ_HEADER, sseReader } from '../src/backend/wire.ts'
import { connect } from '../src/shell/backend-client.ts'
import { backendWith, post, START, TOKEN } from './fixtures/backend-wire.ts'

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

/** Listens until `count` host calls have run, then stops; what ran and how many were lost, by number. */
function listenFor(connection: ReturnType<typeof connect>, count: number, since?: number) {
  const ran: number[] = []
  const lost: number[] = []
  return new Promise<{ ran: number[], lost: number[] }>((resolve) => {
    const stop = connection.listen({
      ...(since === undefined ? {} : { since }),
      host: (call) => {
        ran.push(call.n)
        if (ran.length === count) { stop(); resolve({ ran, lost }) }
        return undefined
      },
      lost: (missed) => { lost.push(missed) },
      ended: () => {},
    })
  })
}

test('a stream ends and the shell listens again: every host call after the last it ran comes, in order, each once, those written to the stream that ended included', { timeout: 5_000 }, async (t) => {
  const { remote, connection } = await backendWith(t, {})
  remote.host.window.send({ type: 'update', seq: 0 })
  remote.host.window.send({ type: 'update', seq: 0 })
  const first = await listenFor(connection, 2)
  // Made at once, before the backend has seen the stream go: written to it, never run.
  remote.host.window.send({ type: 'update', seq: 0 })
  await new Promise((resolve) => setTimeout(resolve, 50))
  // Made while no shell listens.
  remote.host.window.send({ type: 'update', seq: 0 })
  const again = await listenFor(connection, 2, 0)
  assert.deepEqual([first.ran, again.ran, [...first.lost, ...again.lost]], [[1, 2], [3, 4], []])
})

test('more went by than the backend keeps: the shell is told how many it lost, and goes on from what came', { timeout: 10_000 }, async (t) => {
  const dropped: number[] = []
  const remote = createRemoteHost({ start: START, secrets: createEnvelope({ key: randomBytes(32) }), onDropped: (n) => { dropped.push(n) } })
  const server = createRpcServer({ token: TOKEN, channels: new Map(), controls: {}, remote, since: () => [], image: () => new Response(null, { status: 404 }) })
  const port = await server.listen()
  t.after(() => server.close())
  const connection = connect({ port, token: TOKEN })
  remote.host.window.send({ type: 'update', seq: 0 })
  await listenFor(connection, 1)
  await new Promise((resolve) => setTimeout(resolve, 50))
  for (let i = 0; i < 10_002; i++) remote.host.window.send({ type: 'update', seq: 0 })
  const again = await listenFor(connection, 10_000, 0)
  assert.deepEqual([again.ran[0], again.ran.at(-1), again.lost], [4, 10_003, [2]], 'calls 2 and 3 were let go: said once, as two')
  assert.deepEqual(dropped, [2], 'the backend said so once, from the first let go')
})

test('the backend hands a shell listening again only the calls after the one it names', () => {
  const remote = createRemoteHost({ start: START, secrets: createEnvelope({ key: randomBytes(32) }) })
  const gone: number[] = []
  const stop = remote.listen((call) => { gone.push(call.n) })
  remote.host.window.send({ type: 'update', seq: 0 })
  remote.host.window.send({ type: 'update', seq: 0 })
  stop()
  remote.host.window.send({ type: 'update', seq: 0 })
  const seen: number[] = []
  remote.listen((call) => { seen.push(call.n) }, 1)
  remote.host.window.send({ type: 'update', seq: 0 })
  assert.deepEqual([gone, seen], [[1, 2], [2, 3, 4]])
})
