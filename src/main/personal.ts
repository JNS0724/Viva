import { activeHours } from './habits.ts'
import { EXTRA_COMMAND_DIRS, resolveCommand, toAcpServers } from './mcp-config.ts'

type MemoryDb = ReturnType<typeof import('../../plugins/memory/lib/store.ts').openMemoryDb>
type HistoryDb = ReturnType<typeof import('./history-db.ts').openHistoryDb>
type McpStore = ReturnType<typeof import('./mcp-config.ts').createMcpConfigStore>

/**
 * The app's side of what makes the agent personal. Memory itself lives in the dsh plugin
 * (plugins/memory); the app shares its memory.db, so here it only feeds in the habits read from the
 * history, reports after each turn what the plugin saved and what it put in front of the model, and
 * attaches the user's own MCP servers.
 */
export function createPersonal({ memoryDb, historyDb, mcpStore, now = Date.now }: {
  memoryDb: MemoryDb, historyDb: HistoryDb, mcpStore: McpStore, now?: () => number,
}) {
  /** User servers left out because their command was not found; refreshed with every session. */
  let missing: Array<{ name: string, reason: string }> = []
  /** Changes before this have been reported; the plugin's background pass keeps writing after a turn ends. */
  let reportedUntil = now()
  let lastInjection = memoryDb.lastInjectionId()

  function mcpServers(): object[] {
    const resolve = (command: string) => resolveCommand(command, { extraDirs: EXTRA_COMMAND_DIRS })
    const { servers, missing: notFound } = toAcpServers(mcpStore.list(), { resolve })
    missing = notFound
    return servers
  }

  /** Reads the habits from the history and hands their text to the plugin's fixed layer. */
  function habits(): { text: string, samples: number } {
    const { text, samples } = activeHours(historyDb.questionTimes())
    memoryDb.setHabits(text)
    return { text, samples }
  }

  /**
   * What changed since the last call, or null when nothing did: memories the agent saved (claimed for
   * `conversationId`), memories it marked as no longer true, and what the plugin sent
   * with the questions of `sessionId`. Called when a turn ends and again while the background pass may
   * still be writing.
   */
  function collect({ conversationId, sessionId }: { conversationId: string, sessionId: string | null }) {
    const since = reportedUntil
    reportedUntil = now()
    const { memories } = memoryDb.claimChanges(since, conversationId)
    const invalidated = memoryDb.invalidatedSince(since)
    const injected = sessionId ? memoryDb.injectionsAfter(lastInjection, sessionId) : []
    lastInjection = injected.reduce((last, entry) => Math.max(last, entry.id), lastInjection)
    if (memories.length === 0 && invalidated.length === 0 && injected.length === 0) return null
    return { memories: memories.map((memory) => memory.text), invalidated: invalidated.map((memory) => memory.text), injected }
  }

  /**
   * Which servers are attached to the session and which were left out, for the settings page. Memory
   * counts as working when the plugin started inside the dsh launched at `launchedAt`.
   */
  const mcpStatus = (info: any, launchedAt: number) => ({
    active: info?.mcp?.active ?? [],
    memory: launchedAt > 0 && memoryDb.pluginStartedAt() >= launchedAt,
    dropped: [...(info?.mcp?.dropped ?? []), ...missing],
  })

  return { mcpServers, habits, collect, mcpStatus }
}
