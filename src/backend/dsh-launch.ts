import { authVariable, pinArgs } from './plugin-registry.ts'

/**
 * What the app hands dsh as it starts, over the IPC channel rather than in dsh's environment (which other programs
 * of the same user can read, and the agent's commands inherit): the pnpm dsh's plugin manager installs with, the
 * arguments it goes with, and the variables only that pnpm gets (dsh's `packageManager`, "an application-owned
 * package runtime, scoped to plugin package operations"). dsh-entry.ts waits for it before booting dsh; the registry
 * token is the one variable now, and sending each scope to the registry the arguments.
 */
export const LAUNCH_TYPE = 'viva_launch'

/** How long dsh-entry.ts waits for the launch before booting without it. */
export const LAUNCH_WAIT_MS = 10_000

export interface LaunchMessage { type: typeof LAUNCH_TYPE, pnpm: { command: string, args: string[], env: Record<string, string> } }

/** dsh-app-boot's ProfilePnpmInvocation: `args` go before each of the plugin manager's own. */
export interface PnpmInvocation { readonly command: string, readonly args: readonly string[], readonly env: Readonly<Record<string, string>> }

/**
 * With a company registry, pnpm gets its token as a setting of its own and every scope it knows sent to it
 * (plugin-registry.ts); without one, neither.
 */
export function launchMessage({ pnpmCommand, registry, registryToken, scopes }: {
  pnpmCommand: string | null, registry: string | null, registryToken: string, scopes: readonly string[],
}): LaunchMessage {
  const env = registry && registryToken ? { [authVariable(registry)]: registryToken } : {}
  return { type: LAUNCH_TYPE, pnpm: { command: pnpmCommand ?? 'pnpm', args: registry ? pinArgs(registry, scopes) : [], env } }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** The pnpm a launch names, as dsh takes it; undefined for any other message. */
export function packageManagerOf(message: unknown): PnpmInvocation | undefined {
  if (!isRecord(message) || message.type !== LAUNCH_TYPE || !isRecord(message.pnpm)) return undefined
  const { command, args, env } = message.pnpm
  if (typeof command !== 'string' || !command || !isRecord(env)) return undefined
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return undefined
  if (!Object.values(env).every((value) => typeof value === 'string')) return undefined
  return { command, args: args as string[], env: env as Record<string, string> }
}
