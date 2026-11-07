/**
 * What the app hands dsh as it starts, over the IPC channel rather than in dsh's environment (which other programs
 * of the same user can read, and the agent's commands inherit): the pnpm dsh's plugin manager installs with, and the
 * variables only that pnpm gets (dsh's `packageManager`, "an application-owned package runtime, scoped to plugin
 * package operations"). dsh-entry.ts waits for it before booting dsh; the registry token is the one variable now.
 */
export const LAUNCH_TYPE = 'viva_launch'

/** The variable the registry token is in, for pnpm only; the profile's .npmrc names it (plugin-source.ts). */
export const REGISTRY_TOKEN_ENV = 'VIVA_REGISTRY_TOKEN'

/** How long dsh-entry.ts waits for the launch before booting without it. */
export const LAUNCH_WAIT_MS = 10_000

export interface LaunchMessage { type: typeof LAUNCH_TYPE, pnpm: { command: string, env: Record<string, string> } }

/** dsh-app-boot's ProfilePnpmInvocation. */
export interface PnpmInvocation { readonly command: string, readonly args: readonly string[], readonly env: Readonly<Record<string, string>> }

export function launchMessage({ pnpmCommand, registryToken }: { pnpmCommand: string | null, registryToken: string }): LaunchMessage {
  return { type: LAUNCH_TYPE, pnpm: { command: pnpmCommand ?? 'pnpm', env: registryToken ? { [REGISTRY_TOKEN_ENV]: registryToken } : {} } }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** The pnpm a launch names, as dsh takes it; undefined for any other message. */
export function packageManagerOf(message: unknown): PnpmInvocation | undefined {
  if (!isRecord(message) || message.type !== LAUNCH_TYPE || !isRecord(message.pnpm)) return undefined
  const { command, env } = message.pnpm
  if (typeof command !== 'string' || !command || !isRecord(env)) return undefined
  if (!Object.values(env).every((value) => typeof value === 'string')) return undefined
  return { command, args: [], env: env as Record<string, string> }
}
