import { type ChildProcess, fork } from 'node:child_process'
import http from 'node:http'
import type { StoredEvent } from '../backend/event-core.ts'
import { diagnosticContext, emitDiagnostic, withOperation } from '../diagnostics/node/context.ts'
import { encodeDiagnosticEnvelope } from '../diagnostics/node/envelope.ts'
import { diagnosticOperationForChannel } from '../diagnostics/node/operations.ts'
import { diagnosticHub } from '../diagnostics/node/hub.ts'
import { createRequestBudget, MEMORY_READ_BUDGET_MS, INITIALIZATION_BUDGET_MS } from '../shared/request-budget.ts'
import { t } from '../shared/i18n/translate.ts'
import {
  type Answer, bearer, decodeValue, encodeValue, type FailedMessage, type HostCall, isBytes, type ReadyMessage,
  MAX_JSON_BYTES, SEQ_HEADER, sseReader, type StartMessage, TOKEN_HEADER,
} from '../backend/wire.ts'

/**
 * The shell's side of the backend process (docs/system-design.md §3): it starts
 * src/backend/server.ts as Electron run as Node, hands it the launch message, then talks to it over loopback HTTP
 * (calls) and SSE (what the backend asks of the desktop). The two live and end together.
 */
/** How long the backend may take to open its databases and answer `ready`. */
const READY_TIMEOUT_MS = 60_000
/** How long a quitting backend may take to stop dsh and close; then it is killed. */
const EXIT_WAIT_MS = 10_000
/** How long an answer waits for the host calls the backend made before it (wire.ts Answer mark). */
const CATCH_UP_MS = 5_000

export interface Connection {
  /** A page's call on one of the backend's channels; bytes among the arguments are uploaded first. */
  rpc(channel: string, args: readonly unknown[]): Promise<unknown>
  /** One of the shell's own calls (server.ts controls). */
  control<T = unknown>(op: string, ...args: unknown[]): Promise<T>
  /** A viva-image:// picture. */
  image(url: string): Promise<Response>
  /** Answers a notification's click (remote-host.ts keep). */
  callback(id: number, args: unknown[]): Promise<void>
  /**
   * Listens for what the backend asks of the desktop; `ended` when the stream closes. Listening again, `since` is the
   * last stored event seen, and the ones after it come first; the host calls after the last one run come first too,
   * each run once. Some the backend no longer had (a gap in their numbers): `lost`, with how many.
   */
  listen(handlers: {
    host: (call: HostCall) => unknown, stored?: (event: StoredEvent) => void, ended: (err?: Error) => void, since?: number,
    lost?: (count: number) => void,
  }): () => void
}

/** Talks to a backend at `port` (on loopback) with `token`. */
export function connect({ port, token }: { port: number, token: string }): Connection {
  const agent = new http.Agent({ keepAlive: true })
  let seq = 0
  // The host calls run so far, by number (wire.ts HostCall n), and the answers waiting for some still to come.
  let ran = 0
  let listening = false
  let waiters: ReadonlyArray<{ mark: number, release: () => void }> = []

  /** Resolves once the host calls up to `mark` have run: what the backend pushed before answering comes first. */
  function caughtUp(mark: number, signal?: AbortSignal): Promise<void> {
    if (!listening || ran >= mark) return Promise.resolve()
    return withOperation('host.catchup', () => new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        waiters = waiters.filter((waiter) => waiter.release !== release)
      }
      const abort = () => { cleanup(); reject(signal?.reason) }
      const release = () => { cleanup(); resolve() }
      const timer = setTimeout(() => {
        console.error(`[backend] host calls up to ${mark} did not come in ${CATCH_UP_MS / 1000}s; answering anyway`)
        release()
      }, CATCH_UP_MS)
      waiters = [...waiters, { mark, release }]
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    }), { metrics: { mark } })
  }
  function advance(n: number) {
    ran = Math.max(ran, n)
    for (const waiter of waiters.filter((one) => one.mark <= ran)) waiter.release()
  }
  /** The stream is gone: nothing more will come, so no answer waits. */
  function stopListening() {
    listening = false
    for (const waiter of [...waiters]) waiter.release()
  }

  type Reply = { status: number, headers: http.IncomingHttpHeaders, body: Buffer }
  function request(method: 'GET' | 'POST', pathname: string, body: Buffer | readonly Buffer[] | null, headers: Record<string, string> = {}, retried = false, signal?: AbortSignal): Promise<Reply> {
    return new Promise((resolve, reject) => {
      let answered = false
      const req = http.request({
        host: '127.0.0.1', port, method, path: pathname, agent, signal,
        headers: { [TOKEN_HEADER]: bearer(token), ...(body ? { 'content-length': String(Buffer.isBuffer(body) ? body.length : body.reduce((sum, chunk) => sum + chunk.length, 0)) } : {}), ...headers },
      }, (res) => {
        answered = true
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      })
      req.on('error', (err) => {
        // A kept-alive socket the server had just let go: the request never reached it, so it goes again once,
        // with the same number, on a new socket. Lost, its number would hold up every call after it.
        if (!answered && !retried && req.reusedSocket && !signal?.aborted) resolve(request(method, pathname, body, headers, true, signal))
        else reject(err)
      })
      if (body && !Buffer.isBuffer(body)) { req.cork(); for (const chunk of body) req.write(chunk); req.end() }
      else req.end(body ?? undefined)
    })
  }

  async function call(pathname: string, args: readonly unknown[], ordered: boolean, signal?: AbortSignal): Promise<unknown> {
    const business = Buffer.from(JSON.stringify({ args }))
    const encoded = encodeDiagnosticEnvelope(business, diagnosticContext(), MAX_JSON_BYTES)
    if (encoded.dropped) emitDiagnostic({ event: 'context.dropped', operation: 'http', reason: 'transport_budget', metrics: { businessBytes: business.length, diagnosticBytes: encoded.diagnosticBytes } })
    const body = encoded.body
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(ordered ? { [SEQ_HEADER]: String(++seq) } : {}) }
    const res = await request('POST', pathname, body, headers, false, signal)
    let answer: Answer
    try {
      answer = JSON.parse(res.body.toString('utf8')) as Answer
    } catch {
      throw new Error(`the backend answered ${pathname} with status ${res.status} and no JSON`)
    }
    if (typeof answer.mark === 'number') await caughtUp(answer.mark, signal)
    if (!answer.ok) throw Object.assign(new Error(answer.error), { code: answer.code })
    return decodeValue(answer.value)
  }

  async function upload(bytes: Uint8Array | ArrayBuffer): Promise<{ $blob: string }> {
    const res = await request('POST', '/blob', Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes), { 'content-type': 'application/octet-stream' })
    const answer = JSON.parse(res.body.toString('utf8')) as Answer
    if (!answer.ok) throw new Error(answer.error)
    return { $blob: String(answer.value) }
  }

  return {
    async rpc(channel, args) {
      if (channel === 'memory:get' || channel === 'agent:snapshot') {
        const limit = channel === 'memory:get' ? MEMORY_READ_BUDGET_MS : INITIALIZATION_BUDGET_MS
        const requested = (args[0] as { budgetMs?: number } | undefined)?.budgetMs ?? limit
        if (!Number.isFinite(requested) || requested <= 0 || requested > limit) throw new Error('Invalid request budget')
        const lifetime = createRequestBudget(requested)
        try {
          return await withOperation(channel === 'memory:get' ? 'memory.get' : 'startup', () => lifetime.run(() => call(`/rpc/${encodeURIComponent(channel)}`,
            [{ budgetMs: lifetime.remainingMs() }], true, lifetime.signal)), { identities: { methodId: channel } })
        } catch (error) {
          if (channel !== 'memory:get') throw error
          const code = lifetime.signal.aborted ? 'timeout' : error && typeof error === 'object' && 'code' in error ? error.code : 'unavailable'
          throw new Error(t(code === 'timeout' ? 'memory.read.timeout' : code === 'busy' ? 'memory.read.busy' : 'memory.read.unavailable'))
        } finally { lifetime.close() }
      }
      const sent = await Promise.all(args.map((arg) => (isBytes(arg) ? upload(arg) : arg)))
      return withOperation(diagnosticOperationForChannel(channel), () => call(`/rpc/${encodeURIComponent(channel)}`, encodeValue(sent) as unknown[], true), { identities: { methodId: channel } })
    },
    control: async <T>(op: string, ...args: unknown[]) => (await call(`/control/${encodeURIComponent(op)}`, encodeValue(args) as unknown[], true)) as T,
    async image(url) {
      const res = await request('GET', `/image?url=${encodeURIComponent(url)}`, null)
      const headers = Object.entries(res.headers).flatMap(([name, value]) => (typeof value === 'string' ? [[name, value] as [string, string]] : []))
      return new Response(res.status === 200 ? new Uint8Array(res.body) : null, { status: res.status, headers })
    },
    async callback(id, args) {
      await call(`/callback/${id}`, args, false)
    },
    listen({ host, stored = () => {}, ended, since, lost = () => {} }) {
      const answerHost = (id: number, answer: Answer) => {
        request('POST', `/host/${id}`, Buffer.from(JSON.stringify(encodeValue(answer))), { 'content-type': 'application/json' })
          .catch((err: Error) => console.error('[backend] could not answer a host call:', err.message))
      }
      const run = (hostCall: HostCall) => {
        if (hostCall.id === null) {
          try {
            host(hostCall)
          } catch (err) {
            console.error(`[backend] host call ${hostCall.method} failed:`, err)
          }
          return
        }
        const id = hostCall.id
        // Started now, in the order the backend asked; only its answer waits.
        let started: unknown
        try {
          started = host(hostCall)
        } catch (err) {
          started = Promise.reject(err)
        }
        Promise.resolve(started).then(
          (value) => answerHost(id, { ok: true, value }),
          (err: Error) => answerHost(id, { ok: false, error: err?.message ?? String(err) }),
        )
      }
      const read = sseReader((event, data) => {
        if (event === 'host') {
          const hostCall = data as HostCall
          // Run already (a stream before this one had it): once is all.
          if (hostCall.n <= ran) return
          if (hostCall.n > ran + 1) lost(hostCall.n - ran - 1)
          run(hostCall)
          advance(hostCall.n)
        } else if (event === 'stored') stored(data as StoredEvent)
      })
      const end = (err?: Error) => {
        stopListening()
        ended(err)
      }
      listening = true
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: `/events?${new URLSearchParams({ ...(since === undefined ? {} : { since: String(since) }), after: String(ran) })}`, headers: { [TOKEN_HEADER]: bearer(token) } }, (res) => {
        if (res.statusCode !== 200) {
          end(new Error(`the backend refused its events: ${res.statusCode}`))
          res.resume()
          return
        }
        res.setEncoding('utf8')
        res.on('data', read)
        res.on('end', () => end())
        res.on('error', end)
      })
      req.on('error', end)
      req.end()
      return () => {
        stopListening()
        req.destroy()
      }
    },
  }
}

export interface BackendProcess {
  ready: ReadyMessage
  connection: Connection
  pid: number | undefined
  /** Stops dsh, closes the databases, and waits for the process to end (killing it after a while). */
  shutdown(): Promise<void>
}

/**
 * Starts the backend at `entry` and waits for it to be ready. `onExit` is told when it ends on its own (not after
 * `shutdown`): the shell cannot go on without it.
 */
export function spawnBackend({ entry, start, onExit }: {
  entry: string
  start: StartMessage
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void
}): Promise<BackendProcess> {
  const child: ChildProcess = fork(entry, [], {
    execPath: process.execPath,
    // Not the shell's own flags (an automation client's --inspect, Electron's switches).
    execArgv: [],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    serialization: 'json',
  })
  let expected = false
  const diagnostics = diagnosticHub()?.attach('backend', (message, settled) => { child.send(message, settled) })
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      diagnostics?.close()
      resolve()
      if (!expected) onExit(code, signal)
    })
  })

  async function shutdown(connection: Connection) {
    expected = true
    try {
      await connection.control('close')
    } catch (err) {
      console.error('[backend] could not close:', (err as Error).message)
    }
    const timer = setTimeout(() => child.kill(), EXIT_WAIT_MS)
    await exited
    clearTimeout(timer)
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      expected = true
      child.kill()
      reject(new Error(`the backend was not ready in ${READY_TIMEOUT_MS / 1000}s`))
    }, READY_TIMEOUT_MS)
    const early = (code: number | null) => {
      // Not ready yet: the start fails with this; onExit is for a backend that was running.
      expected = true
      clearTimeout(timer)
      reject(new Error(`the backend ended before it was ready (exit ${code})`))
    }
    child.once('exit', early)
    let ready = false
    child.on('message', (raw) => {
      if (diagnostics?.receive(raw)) return
      if (ready || !raw || typeof raw !== 'object' || !('type' in raw) || !['ready', 'failed'].includes(String(raw.type))) return
      ready = true
      clearTimeout(timer)
      child.off('exit', early)
      const message = raw as ReadyMessage | FailedMessage
      if (message?.type !== 'ready') {
        expected = true
        reject(new Error(`the backend could not start: ${(message as FailedMessage)?.message ?? 'no answer'}`))
        return
      }
      const connection = connect({ port: message.port, token: start.token })
      resolve({ ready: message, connection, pid: child.pid, shutdown: () => shutdown(connection) })
    })
    child.send(start)
  })
}
