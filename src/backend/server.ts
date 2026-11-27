import { getLocale } from '../shared/i18n/locale.ts'
import path from 'node:path'
import { createManagedDiagnostics } from '../diagnostics/node/managed.ts'
import { createDiagnosticHub } from '../diagnostics/node/hub.ts'
import { emitDiagnostic, emitDiagnosticFailure, installDiagnosticPort } from '../diagnostics/node/context.ts'
import pkg from '../../package.json' with { type: 'json' }
import { imageResponse } from './image-protocol.ts'
import { checkedIpc } from '../shared/ipc-contract.ts'
import { createBackend } from './compose.ts'
import { createEnvelope } from './envelope.ts'
import { SHELL_PREFERENCES } from './preferences.ts'
import { createRemoteHost } from './remote-host.ts'
import { type ChannelListener, createRpcServer } from './rpc-server.ts'
import { type ChannelKind, type FailedMessage, MIRROR, type ReadyMessage, START, type StartMessage } from './wire.ts'

/**
 * The backend process (docs/system-design.md §3): started by the shell (src/shell/backend-client.ts)
 * as Electron run as Node, given its launch message over the IPC channel, serving the pages' channels and the
 * shell's controls over loopback HTTP. It lives as long as the shell: when the shell's channel closes, it stops dsh
 * and its databases and exits.
 */
/** The signals the shell may send; the others come from inside the backend. */
const SHELL_SIGNALS = new Set(['window.foreground', 'system.woke'])

function reply(message: ReadyMessage) {
  process.send?.(message)
}

/** The shell is told why, then the process ends (once the message is out). */
function fail(message: string): void {
  const failed: FailedMessage = { type: 'failed', message }
  if (!process.send) process.exit(1)
  process.send(failed, () => process.exit(1))
}

async function start(message: StartMessage) {
  const diagnostics = createManagedDiagnostics({ directory: path.join(message.paths.userData, 'diagnostics'), component: 'backend', version: pkg.version })
  installDiagnosticPort(diagnostics)
  const hub = createDiagnosticHub({ component: 'backend', writers: [{ component: 'backend', writer: diagnostics }],
    send: (message, settled) => { if (process.connected && process.send) process.send(message, settled); else settled(new Error('Diagnostic parent disconnected')) } })
  const diagnosticMessage = (raw: unknown) => { hub.receive(raw) }
  process.on('message', diagnosticMessage)
  emitDiagnostic({ event: 'process.start', operation: 'startup', stage: 'start' })
  // Electron as Node is for this process only: what it starts (dsh, pnpm) is told so on its own where it needs it.
  delete process.env.ELECTRON_RUN_AS_NODE
  const secrets = createEnvelope({ key: message.dataKey ? Buffer.from(message.dataKey, 'base64') : null })
  const remote = createRemoteHost({ start: message, secrets, onDropped: (n) => emitDiagnostic({ event: 'operation.progress', operation: 'host.catchup', reason: 'gap', metrics: { mark: n } }) })
  const channels = new Map<string, { kind: ChannelKind, listener: ChannelListener }>()
  const ipc = checkedIpc({
    handle: (channel, listener) => { channels.set(channel, { kind: 'handle', listener }) },
    on: (channel, listener) => { channels.set(channel, { kind: 'on', listener }) },
  }, { onRefused: channel => emitDiagnostic({ event: 'operation.progress', operation: 'ipc', reason: 'validation_failed', identities: { methodId: channel } }) })
  const backend = createBackend({ host: remote.host, ipc })
  backend.open()

  let closing: Promise<void> | null = null
  const server = createRpcServer({
    token: message.token,
    channels,
    remote,
    since: backend.since,
    image: (url) => imageResponse(url, backend.images()),
    onError: (where, err) => emitDiagnosticFailure('http', err, { identities: { methodId: where } }),
    controls: {
      'start-bridge': () => backend.startBridge(),
      signal: (input) => {
        const kind = (input as { kind?: unknown } | null)?.kind
        if (typeof kind !== 'string' || !SHELL_SIGNALS.has(kind)) throw new Error(`the shell may not send signal ${String(kind)}`)
        backend.signal({ kind } as Parameters<typeof backend.signal>[0])
      },
      mirror: (update) => {
        const parsed = MIRROR.partial().parse(update)
        const wasTyping = Boolean(remote.host.window.composerTyping?.())
        remote.mirror(parsed)
        if (wasTyping && parsed.composerTyping === false) backend.wakeReports()
      },
      'settings-view': () => backend.settingsView(),
      'preferences-get': () => backend.preferences().get(),
      'preferences-set': (key, value) => {
        if (typeof key !== 'string' || !SHELL_PREFERENCES.has(key)) throw new Error(`the shell may not set ${String(key)}`)
        return backend.preferences().set(key, value)
      },
      'allow-dropped-files': (paths) => backend.allowDroppedFiles(paths),
      'has-bridge': () => backend.hasBridge(),
      'mark-quitting': () => backend.markQuitting(),
      stop: () => backend.stop(),
      'agent-pid': () => backend.agentPid(),
      'automation.memory-owner-pid': () => {
        if (!message.automation) throw new Error('only for automation')
        return backend.memoryOwnerPid()
      },
      since: (seq) => backend.since(Number(seq)),
      'automation.seed-feed': (item) => seedFeed(message.automation, backend, item),
      'automation.publish-event': (event) => backend.publishAutomation(event),
      close: () => { closing ??= shutdown() },
    },
  })

  async function shutdown() {
    emitDiagnostic({ event: 'process.exit', operation: 'shutdown', reason: 'normal' })
    backend.markQuitting()
    remote.abandon('the shell has gone')
    await backend.stop()
    backend.close()
    // The answer to `close` goes out before the server does.
    setImmediate(() => { hub.close(); process.off('message', diagnosticMessage); void server.close().then(() => diagnostics.close()).finally(() => process.exit(0)) })
  }

  const port = await server.listen()
  // The shell gone (it quit, or crashed): nobody is left to serve.
  process.on('disconnect', () => { closing ??= shutdown() })
  reply({ type: 'ready', port, channels: [...channels].map(([channel, { kind }]) => ({ channel, kind })), locale: getLocale() })
}

/** An item in 动态 for an automation client (smoke tests' showcase); refused outside automation. */
function seedFeed(automation: boolean, backend: ReturnType<typeof createBackend>, raw: unknown) {
  if (!automation) throw new Error('only for automation')
  const { title, body } = (raw ?? {}) as { title?: unknown, body?: unknown }
  if (typeof title !== 'string' || typeof body !== 'string') throw new Error('an item needs a title and a body')
  backend.seedFeed({ title, body })
}

process.once('message', (raw) => {
  const parsed = START.safeParse(raw)
  if (!parsed.success) {
    fail(`bad start message: ${parsed.error.issues[0]?.message}`)
    return
  }
  start(parsed.data).catch((err: Error) => {
    emitDiagnosticFailure('startup', err)
    fail(err?.message ?? String(err))
  })
})
