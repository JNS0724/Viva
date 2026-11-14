import { activeHours } from './habits.ts'
import { EXTRA_COMMAND_DIRS, resolveCommand, toAcpServers } from './mcp-config.ts'
import type { AcpServer } from './mcp-config.ts'

type HistoryDb = ReturnType<typeof import('./history-db.ts').openHistoryDb>
type McpStore = ReturnType<typeof import('./mcp-config.ts').createMcpConfigStore>

/** Personal context computed from history and the user's MCP configuration. */
export function createPersonal({ historyDb, mcpStore }: { historyDb: HistoryDb, mcpStore: McpStore }) {
  let missing: Array<{ name: string, reason: string }> = []

  function mcpServers(): AcpServer[] {
    const resolve = (command: string) => resolveCommand(command, { extraDirs: EXTRA_COMMAND_DIRS })
    const { servers, missing: notFound } = toAcpServers(mcpStore.list(), { resolve })
    missing = notFound
    return servers
  }

  function habits(): { text: string, samples: number } {
    const { text, samples } = activeHours(historyDb.questionTimes())
    return { text, samples }
  }

  const mcpStatus = (info: { mcp?: { active: readonly string[], dropped: readonly { name: string, reason: string }[] } }) => ({
    active: [...(info.mcp?.active ?? [])],
    dropped: [...(info.mcp?.dropped ?? []), ...missing],
  })
  return { mcpServers, habits, mcpStatus }
}
