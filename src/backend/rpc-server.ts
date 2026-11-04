import { randomUUID, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { StoredEvent } from './event-core.ts'
import type { RemoteHost } from './remote-host.ts'
import { type Answer, type ChannelKind, decodeValue, encodeValue, isBlobRef, SEQ_HEADER, sseMessage, TOKEN_HEADER } from './wire.ts'

/**
 * The backend's loopback HTTP server (docs/system-design.md §3); wire.ts lists the routes. Only
 * 127.0.0.1, only requests with the launch token and the server's own Host (a page in a browser can do neither).
 */
const LOOPBACK = '127.0.0.1'
/** A JSON body: a conversation's history is the largest (history:save). */
const MAX_JSON_BYTES = 32 * 1024 * 1024
/** Bytes uploaded before the call that uses them: a pasted picture. */
const MAX_BLOB_BYTES = 64 * 1024 * 1024
/** How long an uploaded blob waits for its call. */
const BLOB_KEEP_MS = 60_000
const KEEP_ALIVE_MS = 15_000
/** How long a call waits for one before it whose number never came (its request was lost); then that turn passes. */
const MISSING_TURN_MS = 5_000

export type ChannelListener = (event: unknown, ...args: unknown[]) => unknown
export interface RpcServerOptions {
  token: string
  channels: ReadonlyMap<string, { kind: ChannelKind, listener: ChannelListener }>
  controls: Readonly<Record<string, (...args: unknown[]) => unknown>>
  remote: Pick<RemoteHost, 'listen' | 'answer' | 'callback' | 'mark'>
  since: (seq: number) => StoredEvent[]
  /** A viva-image:// URL's answer (image-protocol.ts imageResponse). */
  image: (url: string) => Response | Promise<Response>
  onError?: (where: string, err: Error) => void
}

class HttpProblem extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpProblem(413, `body over ${limit} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req, MAX_JSON_BYTES)
  let parsed: unknown
  try {
    parsed = body.length ? JSON.parse(body.toString('utf8')) : {}
  } catch {
    throw new HttpProblem(400, 'the body is no JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpProblem(400, 'the body is no JSON object')
  return parsed as Record<string, unknown>
}

const argsOf = (body: Record<string, unknown>): unknown[] => {
  if (body.args === undefined) return []
  if (!Array.isArray(body.args)) throw new HttpProblem(400, 'args must be an array')
  return body.args
}

function sendJson(res: http.ServerResponse, status: number, body: Answer) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const sameToken = (given: string | undefined, expected: string): boolean => {
  const a = Buffer.from(given ?? '')
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const seqOf = (req: http.IncomingMessage): number | null => {
  const header = req.headers[SEQ_HEADER]
  return typeof header === 'string' && /^\d+$/.test(header) ? Number(header) : null
}

export function createRpcServer({ token, channels, controls, remote, since, image, onError = () => {} }: RpcServerOptions) {
  const blobs = new Map<string, Buffer>()
  const server = http.createServer((req, res) => {
    route(req, res).catch((err: Error) => {
      const status = err instanceof HttpProblem ? err.status : 500
      if (status === 500) onError(`${req.method} ${req.url}`, err)
      if (!res.headersSent) sendJson(res, status, { ok: false, error: err.message })
      else res.end()
    })
  })
  // Loopback, and one shell: idle sockets stay, so a call never goes out on one the server is closing.
  server.keepAliveTimeout = 0
  let port = 0

  /** The call's arguments with uploaded bytes in place; each blob is used once. */
  function withBlobs(args: unknown[]): unknown[] {
    return (decodeValue(args) as unknown[]).map((arg) => {
      if (!isBlobRef(arg)) return arg
      const bytes = blobs.get(arg.$blob)
      if (!bytes) throw new HttpProblem(400, `no blob ${arg.$blob}`)
      blobs.delete(arg.$blob)
      return bytes
    })
  }

  /** Runs a call and answers it; what it throws goes back as the answer's error. */
  async function answer(res: http.ServerResponse, run: () => unknown) {
    try {
      const value = encodeValue(await run())
      sendJson(res, 200, { ok: true, value, mark: remote.mark() })
    } catch (err) {
      sendJson(res, 200, { ok: false, error: (err as Error)?.message ?? String(err), mark: remote.mark() })
    }
  }

  /**
   * Calls start in the order the shell made them (the SEQ_HEADER number), as ipcMain started them in one process:
   * a call starts once those before it have started, not finished, so a dialog waiting for the user holds nothing
   * up. Bodies read at different speeds would otherwise reorder two quick saves.
   */
  const queued = new Map<number, () => void>()
  let nextSeq = 1
  let missing: ReturnType<typeof setTimeout> | undefined
  function drain() {
    for (let next = queued.get(nextSeq); next; next = queued.get(nextSeq)) {
      queued.delete(nextSeq)
      nextSeq += 1
      next()
    }
    clearTimeout(missing)
    missing = undefined
    // Calls wait for one that has not come: if it never does, they go on without it.
    if (queued.size) {
      missing = setTimeout(() => {
        onError('call order', new Error(`call ${nextSeq} never came; the calls after it go on`))
        nextSeq = Math.min(...queued.keys())
        drain()
      }, MISSING_TURN_MS)
      missing.unref?.()
    }
  }
  function inOrder(seq: number | null, begin: () => void) {
    if (seq === null) return begin()
    if (seq < nextSeq) return begin()
    queued.set(seq, begin)
    drain()
  }

  /** A call to a channel or a control, ready to start; what is wrong with it is found before its turn. */
  async function prepare(kind: 'rpc' | 'control', key: string, req: http.IncomingMessage): Promise<() => unknown> {
    const body = await readJson(req)
    if (kind === 'rpc') {
      const entry = channels.get(key)
      if (!entry) throw new HttpProblem(404, `no channel ${key}`)
      const args = withBlobs(argsOf(body))
      return async () => {
        const value = await entry.listener({}, ...args)
        return entry.kind === 'on' ? null : value
      }
    }
    const control = Object.hasOwn(controls, key) ? controls[key] : undefined
    if (!control) throw new HttpProblem(404, `no control ${key}`)
    const args = decodeValue(argsOf(body)) as unknown[]
    return () => control(...args)
  }

  async function ordered(kind: 'rpc' | 'control', key: string, req: http.IncomingMessage, res: http.ServerResponse) {
    const seq = seqOf(req)
    let run: () => unknown
    try {
      run = await prepare(kind, key, req)
    } catch (err) {
      // Its turn passes, or every call after it would wait for it.
      inOrder(seq, () => {})
      throw err
    }
    inOrder(seq, () => { void answer(res, run) })
  }

  function events(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    // A shell listening again says the last stored event it saw; one listening for the first time has none to miss.
    const given = url.searchParams.get('since')
    const after = given === null ? null : Number(given)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    if (after !== null && Number.isFinite(after)) for (const stored of since(after)) res.write(sseMessage('stored', stored))
    const stop = remote.listen((call) => res.write(sseMessage('host', call)))
    const alive = setInterval(() => res.write(': alive\n\n'), KEEP_ALIVE_MS)
    req.on('close', () => {
      clearInterval(alive)
      stop()
    })
  }

  async function sendImage(res: http.ServerResponse, url: string) {
    const response = await image(url)
    const body = Buffer.from(await response.arrayBuffer())
    res.writeHead(response.status, { ...Object.fromEntries(response.headers), 'content-length': body.length })
    res.end(body)
  }

  async function keepBlob(req: http.IncomingMessage, res: http.ServerResponse) {
    const bytes = await readBody(req, MAX_BLOB_BYTES)
    const id = randomUUID()
    blobs.set(id, bytes)
    setTimeout(() => blobs.delete(id), BLOB_KEEP_MS).unref?.()
    sendJson(res, 200, { ok: true, value: id })
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.headers.host !== `${LOOPBACK}:${port}`) throw new HttpProblem(403, 'wrong host')
    if (!sameToken(req.headers[TOKEN_HEADER], `Bearer ${token}`)) throw new HttpProblem(401, 'no token')
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`)
    const [, kind, name = ''] = url.pathname.split('/')
    const key = decodeURIComponent(name)
    if (req.method === 'GET' && kind === 'events') return events(req, res, url)
    if (req.method === 'GET' && kind === 'image') return sendImage(res, url.searchParams.get('url') ?? '')
    if (req.method !== 'POST') throw new HttpProblem(405, 'only POST')
    if (kind === 'blob') return keepBlob(req, res)
    if (kind === 'rpc' || kind === 'control') return ordered(kind, key, req, res)
    const body = await readJson(req)
    if (kind === 'host') {
      if (typeof body.ok !== 'boolean') throw new HttpProblem(400, 'an answer says ok or not')
      const given: Answer = body.ok ? { ok: true, value: body.value } : { ok: false, error: String(body.error) }
      return sendJson(res, 200, { ok: true, value: remote.answer(Number(key), given) })
    }
    if (kind === 'callback') return sendJson(res, 200, { ok: true, value: remote.callback(Number(key), argsOf(body)) })
    throw new HttpProblem(404, `no route ${url.pathname}`)
  }

  return {
    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, LOOPBACK, () => {
          const address = server.address()
          port = typeof address === 'object' && address ? address.port : 0
          resolve(port)
        })
      })
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}
