/**
 * The user's MCP servers between the app and viva-mcp (plugins/mcp): the app sends the whole set whenever the plugin
 * starts or the set changes, the plugin registers them with dsh's MCP manager (one connection for the whole dsh, not
 * one per session) and says how each stands whenever that changes. Secrets travel here only, in memory: nothing of a
 * server is written to the dsh profile.
 */

/** A server as dsh's MCP manager takes it (dsh-mcp-manager McpServerRegistration). */
export type McpEntry =
  | { transport: 'stdio', command: string, args: string[], env: Record<string, string> }
  | { transport: 'streamable-http', url: string, headers: Record<string, string> }

export interface McpServerEntry { name: string, entry: McpEntry }

/** How a server stands, as the window needs it: its state and, when it is not connected, why. */
export interface McpServerState {
  name: string
  /** connected; connecting or reconnecting (trying, maybe after a failure); failed (stopped trying); off. */
  state: 'connected' | 'connecting' | 'reconnecting' | 'failed' | 'off'
  /** The last failure, when there was one. */
  error: string
  /** Tools the server gave, when connected. */
  tools: number
}

export type AppToMcp =
  | { type: 'mcp_servers', version: 1, servers: McpServerEntry[] }
  | { type: 'mcp_restart', version: 1, name: string }

export type McpToApp =
  | { type: 'mcp_ready', version: 1 }
  | { type: 'mcp_status', version: 1, servers: McpServerState[] }

const MAX_SERVERS = 50
const MAX_TEXT = 4000
const STATES: ReadonlySet<string> = new Set(['connected', 'connecting', 'reconnecting', 'failed', 'off'])
const NAME = /^[A-Za-z0-9_-]{1,32}$/

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): value is Record<string, string> => record(value) && Object.values(value).every((item) => typeof item === 'string')

function entryOf(value: unknown): McpEntry | null {
  if (!record(value)) return null
  if (value.transport === 'stdio') {
    const { command, args, env } = value
    if (typeof command !== 'string' || !command || !Array.isArray(args) || !args.every((arg) => typeof arg === 'string') || !strings(env)) return null
    return { transport: 'stdio', command, args: [...args], env: { ...env } }
  }
  if (value.transport === 'streamable-http') {
    const { url, headers } = value
    if (typeof url !== 'string' || !url || !strings(headers)) return null
    return { transport: 'streamable-http', url, headers: { ...headers } }
  }
  return null
}

/** What the app sent, checked by the plugin; anything else is not for it. */
export function appToMcpOf(message: unknown): AppToMcp | null {
  if (!record(message) || message.version !== 1) return null
  if (message.type === 'mcp_restart') return typeof message.name === 'string' && NAME.test(message.name) ? { type: 'mcp_restart', version: 1, name: message.name } : null
  if (message.type !== 'mcp_servers' || !Array.isArray(message.servers) || message.servers.length > MAX_SERVERS) return null
  const servers: McpServerEntry[] = []
  for (const item of message.servers) {
    const entry = record(item) ? entryOf(item.entry) : null
    if (!entry || !record(item) || typeof item.name !== 'string' || !NAME.test(item.name)) return null
    servers.push({ name: item.name, entry })
  }
  return { type: 'mcp_servers', version: 1, servers }
}

/** What the plugin sent, checked by the app; anything else is not from it. */
export function mcpToAppOf(message: unknown): McpToApp | null {
  if (!record(message) || message.version !== 1) return null
  if (message.type === 'mcp_ready') return { type: 'mcp_ready', version: 1 }
  if (message.type !== 'mcp_status' || !Array.isArray(message.servers) || message.servers.length > MAX_SERVERS) return null
  const servers: McpServerState[] = []
  for (const item of message.servers) {
    if (!record(item) || typeof item.name !== 'string' || !NAME.test(item.name) || typeof item.state !== 'string' || !STATES.has(item.state)) return null
    const error = typeof item.error === 'string' ? item.error.slice(0, MAX_TEXT) : ''
    const tools = typeof item.tools === 'number' && Number.isInteger(item.tools) && item.tools >= 0 ? item.tools : 0
    servers.push({ name: item.name, state: item.state as McpServerState['state'], error, tools })
  }
  return { type: 'mcp_status', version: 1, servers }
}
