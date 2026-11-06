import type { createDeskIsland } from './desk-island.ts'

/** An item in 动态, as the showcase shows it (server.ts seedFeed). */
export interface SeededItem { title: string, body: string }

/**
 * Explicit control surface for an external Electron automation client; never loads or runs test code. What is the
 * backend's is asked of its process, so it answers later.
 */
export interface AutomationDriver {
  agentPid: () => Promise<number | null>
  /** The backend process's pid, for a smoke run that checks it is started again (backend-keeper.ts). */
  backendPid: () => number | null
  desk: () => ReturnType<typeof createDeskIsland> | null
  seedFeed: (item: SeededItem) => Promise<void>
}

declare global {
  var vivaAutomation: AutomationDriver | undefined
}

/** Available only in a process explicitly launched with --enable-smoke-test-driver. */
export function installAutomationDriver(enabled: boolean, driver: AutomationDriver): void {
  if (!enabled) return
  Object.defineProperty(globalThis, 'vivaAutomation', { value: Object.freeze(driver), writable: false, configurable: false })
}
