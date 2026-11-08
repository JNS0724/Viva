import { execFileSync } from 'node:child_process'

/**
 * The company's registry (plugin-source.ts) as the pnpm that installs plugins (11, shipped with the app) is made to
 * take it, which no .npmrc line can do:
 * - its token, as the setting `npm_config_//host/path/:_authToken` in pnpm's own environment (dsh-launch.ts): pnpm 11
 *   expands no `${…}` in a project .npmrc, and a value written into any file would be read by anything else;
 * - every scope pnpm knows of (`@scope:registry`, from any .npmrc or pnpm's own `@jsr`) sent to the registry too, on
 *   pnpm's command line, the one place that wins over them: `--registry` and the environment set the default only, so
 *   without this a scope could still be installed from a registry another .npmrc names.
 * The scopes are read once dsh starts, by the same pnpm where it installs; one added to an .npmrc while dsh runs is
 * sent to the registry from the next start.
 */
const SCOPES_TIMEOUT_MS = 10_000
const SCOPE_KEY = /^(@[^:/\s]+):registry$/

/** The registry as npm names it for its token: `//host[:port]/path/`. */
export const authKey = (registry: string): string => registry.replace(/^https?:/, '')

/** The variable that gives pnpm the token for `registry`. */
export const authVariable = (registry: string): string => `npm_config_${authKey(registry)}:_authToken`

/** The scopes given a registry of their own in pnpm's settings, as `pnpm config list --json` has them. */
export function scopesIn(config: unknown): string[] {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return []
  return Object.keys(config).map((key) => SCOPE_KEY.exec(key)?.[1]).filter((scope): scope is string => Boolean(scope))
}

/** pnpm's arguments sending each scope to `registry`. */
export const pinArgs = (registry: string, scopes: readonly string[]): string[] => scopes.map((scope) => `--config.${scope}:registry=${registry}`)

type Run = (command: string, args: readonly string[], options: { cwd: string, env: NodeJS.ProcessEnv, shell: boolean, encoding: 'utf8', timeout: number }) => string

/**
 * The scopes the pnpm at `command` finds in `cwd`, with `env`. A .cmd on Windows runs only through the shell, its path
 * quoted. Throws when pnpm cannot say: no scopes read is not no scopes.
 */
export function pnpmScopes({ command, cwd, env, platform = process.platform, run = execFileSync as unknown as Run }: {
  command: string, cwd: string, env: NodeJS.ProcessEnv, platform?: string, run?: Run,
}): string[] {
  const shell = platform === 'win32'
  const out = run(shell ? `"${command}"` : command, ['config', 'list', '--json'], { cwd, env, shell, encoding: 'utf8', timeout: SCOPES_TIMEOUT_MS })
  return scopesIn(JSON.parse(out))
}
