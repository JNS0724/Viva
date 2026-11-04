import fs from 'node:fs'
import path from 'node:path'
import { handlerOf, type IpcRegistry } from '../shared/ipc-contract.ts'
import type { PluginsOp, PluginsResult } from './plugins-channel.ts'

/**
 * IPC for the 插件 section of settings: the dsh plugins the user installed (bundles in the profile), installed by
 * npm name, git address or folder after the user saw what the spec is, switched, removed. All of it goes to dsh's
 * own plugin manager through viva-plugins (plugins-channel.ts); the app reads only the installed packages'
 * manifests, to say which ones bring a Web interface Viva does not show.
 */
const MAX_LIST = 200
const MAX_TEXT_CHARS = 2000

type Call = (op: PluginsOp, args?: Record<string, unknown>) => Promise<PluginsResult>

/** One row a bundle adds, and how it runs now. */
interface PluginRowView { id: string, entryId: string | null, enabled: boolean, phase: string | null }
/** One installed plugin as the section shows it. */
interface PluginView {
  name: string, version: string | null, description: string | null, enabled: boolean, removable: boolean,
  /** dsh's code for what is wrong with it, with its words; null when nothing is. */
  error: { code: string, detail: string | null } | null,
  /** It brings a part for dsh's Web client (`dsh.client`), which Viva does not run. */
  webUi: boolean
  rows: PluginRowView[]
  /** dsh's own rows it changes. */
  overrides: string[]
}
interface PluginsView { connected: boolean, plugins: PluginView[] }
/** What an install, removal or switch did, as the section words it. */
interface ChangeView { changed: boolean, application: string, error: { code: string, detail: string | null } | null, pendingBuilds: string[] }

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value.slice(0, MAX_TEXT_CHARS) : null)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value.slice(0, MAX_LIST) : [])
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {})
const errorOf = (value: unknown) => {
  const error = record(value)
  const code = str(error.code)
  return code ? { code, detail: str(error.diagnostic) } : null
}

/** Whether the installed package brings a part for dsh's Web client. */
function hasWebUi(profileDir: string, name: string): boolean {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
    return Boolean(manifest?.dsh?.client)
  } catch {
    return false
  }
}

/**
 * The bundles the user installed into the profile (the stock ones come with dsh and are not listed), each with its
 * rows as they run now (listPlugins, by entry id).
 */
export function pluginsView(value: unknown, profileDir: string): PluginView[] {
  const { bundles, plugins } = record(value)
  const running = new Map(list(plugins).map(record).map((entry) => [String(entry.entryId ?? ''), entry]))
  return list(bundles).map(record).filter((bundle) => bundle.installed === true && bundle.optional !== true).map((bundle) => {
    const name = String(bundle.name ?? '')
    return {
      name,
      version: str(bundle.version),
      description: str(bundle.description),
      enabled: bundle.enabled === true,
      removable: bundle.removable === true,
      error: errorOf(bundle.error),
      webUi: hasWebUi(profileDir, name),
      rows: list(bundle.rows).map(record).map((row) => {
        const entryId = str(row.entryId)
        const live = entryId ? running.get(entryId) : undefined
        return { id: String(row.rowId ?? ''), entryId, enabled: live?.enabled === true, phase: str(live?.fiberPhase) }
      }),
      overrides: list(bundle.overrides).map(String),
    }
  })
}

export function changeView(value: unknown): ChangeView {
  const result = record(value)
  return {
    changed: result.changed === true,
    application: String(result.application ?? 'failed'),
    error: errorOf(result.error),
    pendingBuilds: list(result.pendingBuilds).map(String),
  }
}

/** What an inspection found: the package a spec names, or why dsh refuses it. */
export function inspectionView(value: unknown) {
  const found = record(value)
  if (found.status !== 'accepted') return { ok: false as const, problem: String(found.problem ?? 'unknown') }
  return { ok: true as const, name: str(found.name), version: str(found.version), description: str(found.description), bundle: found.bundle === true ? true : found.bundle === false ? false : null }
}

/** The plugin manager's answer, or an error the window shows: dsh not running, or the manager's own words. */
async function ask(call: Call, op: PluginsOp, args?: Record<string, unknown>): Promise<unknown> {
  const result = await call(op, args)
  if (!result.ok) throw new Error(result.problem)
  return result.value
}

export function registerPluginsIpc(ipcMain: Pick<IpcRegistry, 'handle'>, deps: { call: Call, profileDir: () => string }) {
  const handle = handlerOf(ipcMain)
  async function view(): Promise<PluginsView> {
    const result = await deps.call('list')
    if (!result.ok) return { connected: false, plugins: [] }
    return { connected: true, plugins: pluginsView(result.value, deps.profileDir()) }
  }
  const changed = async (op: PluginsOp, args: Record<string, unknown>) => ({ change: changeView(await ask(deps.call, op, args)), view: await view() })

  handle('plugins:get', view)
  handle('plugins:inspect', async (spec) => inspectionView(await ask(deps.call, 'inspect', { spec })))
  handle('plugins:install', (spec, approvedBuilds) => changed('install', { spec, ...(approvedBuilds?.length ? { approvedBuilds } : {}) }))
  handle('plugins:remove', (name) => changed('remove', { name }))
  handle('plugins:set-enabled', (name, enabled) => changed('setBundle', { name, enabled }))
}
