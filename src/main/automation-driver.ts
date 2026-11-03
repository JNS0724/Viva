import type { createDeskIsland } from './desk-island.ts'
import type { Followups } from './followups-main.ts'
import type { openSources } from './sources-main.ts'

/** Explicit control surface for an external Electron automation client; never loads or runs test code. */
export interface AutomationDriver {
  agentPid: () => number | null
  desk: () => ReturnType<typeof createDeskIsland> | null
  sources: () => ReturnType<typeof openSources> | null
  followups: () => Followups | null
}

declare global {
  var vivaAutomation: AutomationDriver | undefined
}

/** Available only in a process explicitly launched with --enable-smoke-test-driver. */
export function installAutomationDriver(enabled: boolean, driver: AutomationDriver): void {
  if (!enabled) return
  Object.defineProperty(globalThis, 'vivaAutomation', { value: Object.freeze(driver), writable: false, configurable: false })
}
