/**
 * The plugin's side of the plugins contract (src/main/plugins-channel.ts): the app asks (`plugins_call`), this
 * asks dsh's plugin manager and answers (`plugins_result`). Arguments are checked here as well as in the app:
 * a malformed call is refused, never passed on.
 */
export const PLUGINS_OPS = Object.freeze(['list', 'inspect', 'install', 'remove', 'setBundle', 'setPlugin'] as const)
export type PluginsOp = typeof PLUGINS_OPS[number]

const MAX_SPEC_CHARS = 2048
const MAX_NAME_CHARS = 214
const MAX_BUILDS = 50

/** What of dsh's plugin manager (ctx.pluginManager) the page uses. */
export interface Manager {
  listBundles(): Promise<unknown>
  listPlugins(): Promise<unknown>
  inspect(spec: string): Promise<unknown>
  installBundle(spec: string, options?: { approvedBuilds?: string[] }): Promise<unknown>
  removeBundle(name: string): Promise<unknown>
  setBundleEnabled(name: string, enabled: boolean): Promise<unknown>
  setPluginEnabled(id: string, enabled: boolean): Promise<unknown>
}

export interface Port {
  send: (message: object) => unknown
  on: (event: 'message', handler: (message: unknown) => void) => unknown
  off: (event: 'message', handler: (message: unknown) => void) => unknown
}

type Args = Record<string, unknown>

const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('invalid argument')
  return value.trim()
}
const flag = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('invalid argument')
  return value
}
const builds = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_BUILDS) throw new Error('invalid argument')
  return value.map((name) => text(name, MAX_NAME_CHARS))
}

/** Runs one call against the manager; throws on an unknown op or bad arguments. */
export async function runCall(manager: Manager, op: string, args: Args): Promise<unknown> {
  switch (op) {
    case 'list': {
      const [bundles, plugins] = await Promise.all([manager.listBundles(), manager.listPlugins()])
      return { bundles, plugins }
    }
    case 'inspect': return manager.inspect(text(args.spec, MAX_SPEC_CHARS))
    case 'install': {
      const approvedBuilds = builds(args.approvedBuilds)
      return manager.installBundle(text(args.spec, MAX_SPEC_CHARS), approvedBuilds ? { approvedBuilds } : {})
    }
    case 'remove': return manager.removeBundle(text(args.name, MAX_NAME_CHARS))
    case 'setBundle': return manager.setBundleEnabled(text(args.name, MAX_NAME_CHARS), flag(args.enabled))
    case 'setPlugin': return manager.setPluginEnabled(text(args.id, MAX_SPEC_CHARS), flag(args.enabled))
    default: throw new Error(`unknown operation: ${op}`)
  }
}

/** Answers the app's calls until the returned function stops it. */
export function serveCalls(manager: Manager, port: Port): () => void {
  const onMessage = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return
    const message = raw as Record<string, unknown>
    if (message.type !== 'plugins_call' || typeof message.id !== 'string') return
    const id = message.id
    const args = message.args && typeof message.args === 'object' ? message.args as Args : {}
    runCall(manager, String(message.op ?? ''), args)
      .then((value) => port.send({ type: 'plugins_result', id, ok: true, value: value ?? null }))
      .catch((err: unknown) => port.send({ type: 'plugins_result', id, ok: false, problem: err instanceof Error ? err.message : String(err) }))
  }
  port.on('message', onMessage)
  return () => port.off('message', onMessage)
}
