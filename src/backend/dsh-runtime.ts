import path from 'node:path'

/**
 * dsh is part of the app, not something it borrows from the user's machine. It runs on the app's own
 * runtime (Electron as Node: dsh's native addons accept the Electron versions it lists, and package.json
 * pins one of them), keeps its home inside the app's data folder, and sees none of the user's own dsh
 * settings. So the user's `dsh`, its `~/.dsh` and their shell's DSH_ and DEEPSEEK_ variables neither reach
 * Viva nor are touched by it.
 */

/** Where the app's dsh keeps its profile, sessions, credentials and skills. */
export const dshHomeFor = (userData: string): string => path.join(userData, 'dsh')
/** dsh-skill-filesystem also scans `~/.agents/skills`; the app's dsh scans this instead. */
const agentsHomeFor = (dshHome: string): string => path.join(dshHome, 'agents')

/**
 * Variables that steer dsh (its home, endpoint, keys, runtime). The user's values are never passed on;
 * the app sets the ones it means. Matched without regard to case, as Windows treats names.
 */
const OWNED_PREFIXES = Object.freeze(['DSH_', 'DEEPSEEK_', 'ELECTRON_', 'VIVA_'])
const isOwned = (name: string) => OWNED_PREFIXES.some((prefix) => name.toUpperCase().startsWith(prefix))

/** What runs dsh: the app's own executable as Node, or (for development) the Node named by DSH_NODE. */
export interface DshRuntime { nodeBin: string, electron: boolean }

/**
 * The environment dsh runs with: the user's environment (PATH and the like, which MCP servers need too)
 * without anything that steers dsh, then exactly what the app sets.
 * settings: keys and endpoints the app hands over (DEEPSEEK_API_KEY, each provider's key, a test endpoint).
 */
export function dshEnv({ base, dshHome, runtime, settings }: {
  base: NodeJS.ProcessEnv, dshHome: string, runtime: { electron: boolean }, settings: Record<string, string>,
}): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(base).filter(([name]) => !isOwned(name)))
  return {
    ...inherited,
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: agentsHomeFor(dshHome),
    ...(runtime.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...settings,
  }
}

export function dshRuntime({ env, execPath }: { env: NodeJS.ProcessEnv, execPath: string }): DshRuntime {
  return env.DSH_NODE ? { nodeBin: env.DSH_NODE, electron: false } : { nodeBin: execPath, electron: true }
}
