import { activeHours } from './habits.ts'
import { EXTRA_COMMAND_DIRS, resolveCommand, toManagerServers } from './mcp-config.ts'
import type { AgentInfo } from '../shared/agent-info.ts'
import type { McpServerEntry } from '../shared/mcp-channel.ts'

type HistoryDb = ReturnType<typeof import('./history-db.ts').openHistoryDb>
type McpStore = Pick<ReturnType<typeof import('./mcp-config.ts').createMcpConfigStore>, 'list'>

/** Personal context computed from history and the user's MCP configuration. */
export function createPersonal({ historyDb, mcpStore }: { historyDb: HistoryDb, mcpStore: McpStore }) {
  let missing: Array<{ name: string, reason: string }> = []

  /** The servers for viva-mcp (dsh's MCP manager); one whose command cannot be found is left out and said so. */
  function mcpServers(): McpServerEntry[] {
    const resolve = (command: string) => resolveCommand(command, { extraDirs: EXTRA_COMMAND_DIRS })
    const { servers, missing: notFound } = toManagerServers(mcpStore.list(), { resolve })
    missing = notFound
    return servers
  }

  function habits(): { text: string, samples: number } {
    const { text, samples } = activeHours(historyDb.questionTimes())
    return { text, samples }
  }

  /** The manager reports connection and startup errors. Also show commands Viva could not find. */
  const mcpStatus = (info: Pick<AgentInfo, 'mcp'>) => ({
    active: [...(info.mcp?.active ?? [])],
    connecting: [...(info.mcp?.connecting ?? [])],
    dropped: [...(info.mcp?.dropped ?? []), ...missing],
  })
  return { mcpServers, habits, mcpStatus }
}
