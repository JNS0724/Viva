import { mcpToAppOf, type McpServerEntry, type McpServerState } from '../shared/mcp-channel.ts'

/**
 * The app's side of viva-mcp (plugins/mcp, shared/mcp-channel.ts): the user's MCP servers go to the plugin when it
 * starts and again whenever they change, without touching any session; how each stands comes back, for the settings
 * page and for the one-time note that a server could not connect.
 */
export interface McpStatus {
  /** Connected servers. */
  active: string[]
  /** Servers trying to connect (first time, or again after a failure, with the failure). */
  connecting: Array<{ name: string, reason: string }>
  /** Servers that stopped trying, with why. */
  dropped: Array<{ name: string, reason: string }>
}

export const NO_MCP_STATUS: McpStatus = Object.freeze({ active: [], connecting: [], dropped: [] }) as McpStatus

/** The plugin's states, as the settings page groups them. */
export function statusOf(states: readonly McpServerState[]): McpStatus {
  return {
    active: states.filter((server) => server.state === 'connected').map((server) => server.name),
    connecting: states.filter((server) => server.state === 'connecting' || server.state === 'reconnecting').map((server) => ({ name: server.name, reason: server.error })),
    dropped: states.filter((server) => server.state === 'failed').map((server) => ({ name: server.name, reason: server.error })),
  }
}

export function createMcpDesk({ send, servers, onStatus }: {
  send: (message: object) => void
  /** The servers as configured now. */
  servers: () => McpServerEntry[]
  /** How they stand changed. */
  onStatus: (status: McpStatus) => void
}) {
  let status: McpStatus = NO_MCP_STATUS
  const push = () => send({ type: 'mcp_servers', version: 1, servers: servers() })

  /** A message from dsh: the plugin starting (it gets the servers) or saying how they stand. */
  function receive(raw: unknown) {
    const message = mcpToAppOf(raw)
    if (!message) return
    if (message.type === 'mcp_ready') return push()
    status = statusOf(message.servers)
    onStatus(status)
  }

  return {
    receive,
    /** The servers changed: the plugin takes the new set at once; sessions are not touched. */
    push,
    /** 重试: the manager starts the server again, with a fresh retry budget. */
    restart: (name: string) => send({ type: 'mcp_restart', version: 1, name }),
    status: () => status,
  }
}
