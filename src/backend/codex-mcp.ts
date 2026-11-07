/**
 * Codex's MCP servers (`[mcp_servers.<name>]` in its config.toml) written as the other clients write theirs, for
 * mcp-import.ts to read and check like any: a variable Codex lets through from the environment (`env_vars`,
 * `env_http_headers`, `bearer_token_env_var`) becomes a key written `${VAR}`, filled in from the login shell. Codex
 * keeps every other value as written; one with `${…}` in it, Viva would fill in instead, so it is not taken. A setting
 * Viva cannot do (a folder to start in, another environment, a variable from one, a command that prints the headers,
 * a list of the tools allowed, any setting not known here) is named, and the server not taken; one switched off in
 * Codex is said to be.
 */
export interface ClientEntry {
  /** Its name in the client's settings. */
  entry: string
  /** As the other clients write a server: command, args, env; or type http, url, headers. */
  value: unknown
  /** Switched off in the client. */
  off: boolean
  /** The setting Viva cannot do, when one is used. */
  unsupported: string | null
}

const REF_TEST = /\$\{[^}]*\}/

const table = (value: unknown): Record<string, unknown> | null =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null)
const texts = (value: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(table(value) ?? {}).map(([name, text]) => [name, String(text)]))
const ref = (name: string) => `\${${name}}`

/** The variables a server lets through, by name; null when one is from a remote environment. */
function passedThrough(value: unknown): string[] | null {
  const names = (Array.isArray(value) ? value : []).map((item) => {
    if (typeof item === 'string') return item
    const named = table(item)
    if (!named || typeof named.name !== 'string') return ''
    return named.source === undefined || named.source === 'local' ? named.name : null
  })
  return names.includes(null) ? null : names.filter((name): name is string => Boolean(name))
}

/** The settings `written` carries over. */
const CARRIED = ['command', 'args', 'env', 'env_vars', 'url', 'http_headers', 'env_http_headers', 'bearer_token_env_var']
/** Those left out with nothing lost: being on (`off` says), how long Codex waits, whether it must start. */
const LEFT_OUT = ['enabled', 'required', 'startup_timeout_sec', 'startup_timeout_ms', 'tool_timeout_sec', 'supports_parallel_tool_calls']
const KNOWN = new Set([...CARRIED, ...LEFT_OUT])
/** The environment that is this computer; a server in any other would be reached, or run, here instead. */
const LOCAL_ENVIRONMENT = 'local'

/**
 * The first setting Viva cannot do; null when none. Only those known to be carried over or safe to leave out are
 * taken, so a setting Codex adds later (or one like `enabled_tools`, whose loss would offer tools turned off there)
 * stops the server rather than being dropped.
 */
function unsupported(server: Record<string, unknown>, literals: Record<string, Record<string, string>>): string | null {
  const other = Object.keys(server).find((setting) => !KNOWN.has(setting) && !(setting === 'environment_id' && server[setting] === LOCAL_ENVIRONMENT))
  if (other) return other
  if (passedThrough(server.env_vars) === null) return 'env_vars'
  const withRef = Object.entries(literals).find(([, values]) => Object.values(values).some((text) => REF_TEST.test(text)))
  return withRef ? withRef[0] : null
}

/**
 * Headers from each place, a later one over an earlier: by name in any case, as HTTP reads them (and Viva checks
 * them), so `authorization` written and a bearer token make one Authorization, not a name given twice.
 */
const headersOf = (...layers: ReadonlyArray<Record<string, string>>): Record<string, string> =>
  layers.flatMap((layer) => Object.entries(layer)).reduce<Record<string, string>>((headers, [name, value]) => ({
    ...Object.fromEntries(Object.entries(headers).filter(([kept]) => kept.toLowerCase() !== name.toLowerCase())),
    [name]: value,
  }), {})

function written(server: Record<string, unknown>): unknown {
  if (typeof server.url === 'string' && server.command === undefined) {
    const fromEnv = Object.fromEntries(Object.entries(texts(server.env_http_headers)).map(([header, name]) => [header, ref(name)]))
    const bearer: Record<string, string> = typeof server.bearer_token_env_var === 'string' ? { Authorization: `Bearer ${ref(server.bearer_token_env_var)}` } : {}
    return { type: 'http', url: server.url, headers: headersOf(texts(server.http_headers), fromEnv, bearer) }
  }
  if (server.command === undefined) return {}
  const fromEnv = Object.fromEntries((passedThrough(server.env_vars) ?? []).map((name) => [name, ref(name)]))
  return { command: server.command, args: Array.isArray(server.args) ? server.args : [], env: { ...fromEnv, ...texts(server.env) } }
}

/** The servers a parsed config.toml names; none when it has none. */
export function codexServers(config: unknown): ClientEntry[] {
  const servers = table(table(config)?.mcp_servers)
  if (!servers) return []
  return Object.entries(servers).map(([entry, raw]) => {
    const server = table(raw)
    if (!server) return { entry, value: {}, off: false, unsupported: null }
    return {
      entry,
      value: written(server),
      off: server.enabled === false,
      unsupported: unsupported(server, { env: texts(server.env), http_headers: texts(server.http_headers) }),
    }
  })
}
