import { t } from '../shared/i18n/translate.ts'
import { handlerOf, type IpcRegistry } from './ipc-contract.ts'
import { checkConfigValues, type CheckResult, type ConfigField, type ConfigValues, type SourceManifest } from './source-contract.ts'
import type { BrokenFolder, SourceFolder } from './source-folders.ts'
import { inspectFolder, installFolder, removeFolder, type Inspected } from './source-install.ts'
import type { Ran } from './source-run.ts'
import type { SourcePoller } from './source-poller.ts'
import type { SettingsChange, SourceSettingsStore } from './source-settings.ts'
import type { SourcesDb } from './sources-db.ts'

/**
 * IPC for the 消息源 section of settings: the sources found in the sources folder, each with the form its
 * viva-source.json declares, whether it is on, how it has been doing and what it handed in last. Saving
 * applies at the source's next run; nothing restarts. Secret values come in from the form and never go back.
 * Installing takes two steps, choosing a folder (shown for a yes) then installing it; the folder is never given
 * by the page, only picked in the system's dialog and kept here in between.
 */
const LATEST_SHOWN = 3
const PREVIEW_CHARS = 80

export interface SourcesIpcDeps {
  /** The sources folder's contents as they are now (source-folders.ts). */
  list: () => { sources: SourceFolder[], broken: BrokenFolder[] }
  /** The sources folder. */
  root: string
  /** A folder as settings shows it (shortened under home). */
  label: (dir: string) => string
  settings: SourceSettingsStore
  db: Pick<SourcesDb, 'health' | 'latest' | 'forget'>
  poller: Pick<SourcePoller, 'refresh' | 'pollNow' | 'isRunning'>
  check: (folder: SourceFolder, config: ConfigValues) => Promise<Ran<CheckResult>>
  openFolder: () => Promise<void>
  /** The system's folder dialog; null when the user cancels. */
  chooseFolder: () => Promise<string | null>
  /** Moves a folder to the trash. */
  trash: (dir: string) => Promise<void>
  /** Deletes what the source kept for itself (its data folder), once it is removed. */
  dropData: (id: string) => void
}

/** A field as the form draws it. */
const fieldView = (key: string, field: ConfigField) => ({ key, ...field })

function sourceView(folder: SourceFolder, deps: SourcesIpcDeps) {
  const { manifest } = folder
  const { cursor: _cursor, id: _id, ...health } = deps.db.health(manifest.id)
  return {
    id: manifest.id,
    name: manifest.name,
    kind: manifest.kind,
    reads: manifest.reads,
    command: manifest.run.join(' '),
    fields: Object.entries(manifest.config).map(([key, field]) => fieldView(key, field)),
    settings: deps.settings.view(manifest),
    health,
    running: deps.poller.isRunning(manifest.id),
    latest: deps.db.latest(manifest.id, LATEST_SHOWN)
      .map((m) => ({ id: m.id, at: m.at, from: m.from ?? '', title: m.title ?? m.text?.slice(0, PREVIEW_CHARS) ?? '' })),
  }
}

/** The form as sent, shapes only: settings.save checks what the values mean against the manifest. */
export function formChange(input: Readonly<Record<string, unknown>>): SettingsChange {
  const { enabled, everyMinutes, values } = input
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('invalid enabled')
  if (everyMinutes !== undefined && typeof everyMinutes !== 'number') throw new Error('invalid everyMinutes')
  if (values !== undefined && (values === null || typeof values !== 'object' || Array.isArray(values))) throw new Error('invalid values')
  return { enabled, everyMinutes, values: values as Readonly<Record<string, unknown>> | undefined }
}

/** What to test: the form's values over the saved ones, a blank secret keeping the saved one. */
function valuesToTest(manifest: SourceManifest, saved: ConfigValues, typed: Readonly<Record<string, unknown>>): ConfigValues {
  const kept = Object.entries(typed).filter(([key, value]) => !(manifest.config[key]?.type === 'secret' && (value === '' || value === undefined)))
  const checked = checkConfigValues(manifest.config, { ...saved, ...Object.fromEntries(kept) })
  if (checked.problem !== undefined) throw new Error(checked.problem)
  return checked.values
}

export function registerSourcesIpc(ipcMain: Pick<IpcRegistry, 'handle'>, deps: SourcesIpcDeps) {
  const handle = handlerOf(ipcMain)
  /** The folder chosen and checked, waiting for the user's yes. */
  let pending: Inspected | null = null
  /** Sources being tested (测试连接) right now: their folder is in use, as when they poll. */
  const checking = new Set<string>()

  /** What the confirmation shows: who the source is, what it will run and read, and whether it replaces one. */
  const pendingView = (inspected: Inspected, installed: readonly SourceFolder[]) => ({
    id: inspected.manifest.id,
    name: inspected.manifest.name,
    kind: inspected.manifest.kind,
    reads: inspected.manifest.reads,
    command: inspected.manifest.run.join(' '),
    fields: Object.values(inspected.manifest.config).map((field) => field.title),
    from: deps.label(inspected.dir),
    files: inspected.files,
    bytes: inspected.bytes,
    replaces: installed.some((folder) => folder.manifest.id === inspected.manifest.id),
  })

  const view = () => {
    const { sources, broken } = deps.list()
    return {
      folder: deps.label(deps.root),
      sources: sources.map((folder) => sourceView(folder, deps)),
      broken: broken.map((item) => ({ name: item.name, problem: item.problem })),
      pending: pending ? pendingView(pending, sources) : null,
    }
  }

  /** Replacing or removing a source while it runs would pull its folder from under it (Windows refuses outright). */
  function idle(id: string) {
    if (deps.poller.isRunning(id) || checking.has(id)) throw new Error(t("main.sources-ipc.fetching.in.progress.try.again.shortly"))
  }

  function folderOf(id: string): SourceFolder {
    const folder = deps.list().sources.find((source) => source.manifest.id === id)
    if (!folder) throw new Error(t("main.sources-ipc.this.source.is.no.longer.available.try"))
    return folder
  }

  // Reading the page also picks up folders added or removed by hand since.
  handle('sources:get', () => {
    deps.poller.refresh()
    return view()
  })

  handle('sources:save', (id, input) => {
    const folder = folderOf(id)
    deps.settings.save(folder.manifest, formChange(input))
    deps.poller.refresh()
    return view()
  })

  handle('sources:check', async (id, input) => {
    const folder = folderOf(id)
    const typed = formChange(input ?? {}).values ?? {}
    const values = valuesToTest(folder.manifest, deps.settings.get(folder.manifest).values, typed)
    checking.add(id)
    let ran: Ran<CheckResult>
    try {
      ran = await deps.check(folder, values)
    } finally {
      checking.delete(id)
    }
    if (!ran.ok) return { ok: false, problem: ran.problem }
    return ran.value.ok ? { ok: true } : { ok: false, problem: ran.value.problem }
  })

  handle('sources:poll-now', async (id) => {
    folderOf(id)
    await deps.poller.pollNow(id)
    return view()
  })

  handle('sources:open-folder', () => deps.openFolder())

  handle('sources:choose', async () => {
    const dir = await deps.chooseFolder()
    if (!dir) return { ...view(), cancelled: true }
    const inspected = inspectFolder(dir, deps.root)
    if ('problem' in inspected) throw new Error(inspected.problem)
    pending = inspected
    return view()
  })

  handle('sources:install', async () => {
    if (!pending) throw new Error(t("main.sources-ipc.choose.a.folder.to.install.first"))
    const inspected = pending
    idle(inspected.manifest.id)
    pending = null
    await installFolder(inspected, deps.root)
    deps.poller.refresh()
    return { ...view(), installed: inspected.manifest.name }
  })

  handle('sources:cancel-install', () => {
    pending = null
    return view()
  })

  handle('sources:remove', async (id) => {
    const folder = folderOf(id)
    idle(id)
    const how = await removeFolder(folder, deps.root, deps.trash)
    deps.settings.remove(id)
    deps.db.forget(id)
    deps.dropData(id)
    deps.poller.refresh()
    return { ...view(), removed: how }
  })
}
