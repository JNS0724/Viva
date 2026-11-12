/**
 * viva-mcp: the user's MCP servers, connected once for the whole dsh by dsh's MCP manager instead of with every
 * session. A server that hangs or fails then costs nothing but its own tools: sessions open at once, the manager keeps
 * trying it in the background, and its tools appear when it connects (docs/system-design.md §6).
 *
 * The app sends the whole set over the IPC channel when the plugin starts and whenever it changes (src/backend/
 * mcp-desk.ts); each is registered with the manager for as long as it is in the set, its secrets in memory only. How
 * each stands goes back to the app on every change, for 能力 · MCP; the page's 重试 restarts one.
 * Loaded by the app's dsh profile (src/backend/dsh-profile.ts), with the manager's own row.
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { McpManagedServerStatus } from '@deepseek-ai/dsh-mcp-manager'
import { appToMcpOf, type McpServerEntry, type McpServerState } from '../../src/shared/mcp-channel.ts'

export const name = 'viva-mcp'
export const inject = ['mcpManager']
export const Config = z.object({})

const log = (message: string) => process.stderr.write(`[${name}] ${message}\n`)
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** A manager status as the window needs it. */
export function stateOf(status: McpManagedServerStatus): Omit<McpServerState, 'name'> {
  switch (status.state) {
    case 'connected': return { state: 'connected', error: '', tools: status.toolCount }
    case 'connecting': return { state: 'connecting', error: '', tools: 0 }
    case 'reconnecting': return { state: 'reconnecting', error: status.lastError, tools: 0 }
    case 'waiting-credentials': return { state: 'failed', error: status.lastError, tools: 0 }
    case 'failed': return { state: 'failed', error: 'lastError' in status ? (status.lastError ?? '') : 'reason' in status ? String(status.reason) : '', tools: 0 }
    default: return { state: 'off', error: '', tools: 0 }
  }
}

/** @param port the channel to the app (tests pass their own) */
export function apply(ctx: Context, _config: object, port: NodeJS.Process = process) {
  if (typeof port.send !== 'function') {
    log('dsh was not started by the app: no MCP servers are registered')
    return
  }
  const send = (message: object) => { if (port.connected !== false) port.send!(message, () => {}) }
  /** What is registered now, by name: the entry as sent (to tell a change) and how to take it back. */
  const registered = new Map<string, { key: string, release: () => void }>()
  /** Servers the manager refused to take, with why. */
  const refused = new Map<string, string>()

  function report() {
    const live = ctx.mcpManager.list().filter((view) => view.configured && registered.has(view.name))
    const servers: McpServerState[] = [
      ...live.map((view) => ({ name: view.name, ...stateOf(view.status) })),
      ...[...refused].map(([server, error]) => ({ name: server, state: 'failed' as const, error, tools: 0 })),
    ]
    send({ type: 'mcp_status', version: 1, servers })
  }

  /** The set as the app has it now: a server gone or changed is taken back, a new or changed one registered. */
  function reconcile(servers: readonly McpServerEntry[]) {
    const wanted = new Map(servers.map((server) => [server.name, { ...server, key: JSON.stringify(server.entry) }]))
    for (const [server, held] of registered) {
      if (wanted.get(server)?.key === held.key) continue
      held.release()
      registered.delete(server)
    }
    refused.clear()
    for (const [server, { entry, key }] of wanted) {
      if (registered.has(server)) continue
      try {
        registered.set(server, { key, release: ctx.mcpManager.register(server, entry) })
      } catch (err) {
        refused.set(server, messageOf(err))
        log(`server "${server}" was not taken: ${messageOf(err)}`)
      }
    }
    report()
  }

  const receive = (raw: unknown) => {
    const message = appToMcpOf(raw)
    if (!message) return
    if (message.type === 'mcp_servers') return reconcile(message.servers)
    if (!registered.has(message.name)) return
    ctx.mcpManager.restart(message.name).catch((err: unknown) => log(`server "${message.name}" could not restart: ${messageOf(err)}`))
  }
  port.on('message', receive)
  // The channel must not keep dsh running once its input closes.
  port.channel?.unref?.()
  ctx.on('mcp-manager/status', (server: string) => { if (registered.has(server)) report() })
  ctx.effect(() => () => {
    port.off('message', receive)
    for (const held of registered.values()) held.release()
    registered.clear()
  }, 'mcp registrations')
  send({ type: 'mcp_ready', version: 1 })
}
