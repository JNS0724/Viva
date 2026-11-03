import type { createDeskIsland } from './desk-island.ts'

/** A follow-up already prepared, as the showcase shows it (server.ts seedPrepared). */
export interface PreparedFollowup { title: string, ask: string, prepareBy: number, draft: string }

/**
 * Explicit control surface for an external Electron automation client; never loads or runs test code. What is the
 * backend's is asked of its process, so it answers later.
 */
export interface AutomationDriver {
  agentPid: () => Promise<number | null>
  desk: () => ReturnType<typeof createDeskIsland> | null
  seedPrepared: (item: PreparedFollowup) => Promise<void>
}

declare global {
  var vivaAutomation: AutomationDriver | undefined
}

/** Available only in a process explicitly launched with --enable-smoke-test-driver. */
export function installAutomationDriver(enabled: boolean, driver: AutomationDriver): void {
  if (!enabled) return
  Object.defineProperty(globalThis, 'vivaAutomation', { value: Object.freeze(driver), writable: false, configurable: false })
}
