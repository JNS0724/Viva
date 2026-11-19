import { t } from '../shared/i18n/translate.ts'
import { handlerOf, type IpcRegistry } from '../shared/ipc-contract.ts'
import type { FeedSourceRunResult, FeedSourceView } from '../shared/feed-source.ts'
import { feedSourceViewOf, type FeedSourceStore } from './feed-source-store.ts'

/**
 * IPC handlers for plugin-backed 动态 data sources: list, create, update, pause/resume, delete,
 * and immediate manual execution. State changes notify the runner and renderer via `changed()`.
 */
export function registerFeedSourceIpc(ipcMain: Pick<IpcRegistry, 'handle'>, deps: {
  store: () => FeedSourceStore
  cwd: () => string
  validatePlugin?: (pluginName: string) => Promise<{ ok: true } | { ok: false, reason: string }>
  runNow: (id: string) => Promise<FeedSourceRunResult>
  changed: () => void
}) {
  const handle = handlerOf(ipcMain)

  handle('feed-sources:list', (): FeedSourceView[] => deps.store().list().map(feedSourceViewOf))

  handle('feed-sources:create', async (input): Promise<FeedSourceView> => {
    const raw = input as Record<string, unknown>
    const pluginName = String(raw.pluginName ?? '').trim()
    if (pluginName && deps.validatePlugin) {
      const checked = await deps.validatePlugin(pluginName)
      if (!checked.ok) throw new Error(checked.reason)
    }
    const created = deps.store().create({
      pluginName,
      name: typeof raw.name === 'string' ? raw.name : undefined,
      instruction: String(raw.instruction ?? ''),
      schedule: raw.schedule,
      cwd: deps.cwd(),
    })
    deps.changed()
    return feedSourceViewOf(created)
  })

  handle('feed-sources:update', (id, changes): FeedSourceView => {
    const raw = changes as Record<string, unknown>
    const updated = deps.store().update(id, {
      ...(raw.name !== undefined ? { name: String(raw.name) } : {}),
      ...(raw.instruction !== undefined ? { instruction: String(raw.instruction) } : {}),
      ...(raw.schedule !== undefined ? { schedule: raw.schedule } : {}),
      ...(typeof raw.paused === 'boolean' ? { paused: raw.paused } : {}),
    })
    if (!updated) throw new Error(t('main.feed-sources.not.found'))
    deps.changed()
    return feedSourceViewOf(updated)
  })

  handle('feed-sources:pause', (id, paused): FeedSourceView => {
    const updated = deps.store().setPaused(id, paused)
    if (!updated) throw new Error(t('main.feed-sources.not.found'))
    deps.changed()
    return feedSourceViewOf(updated)
  })

  handle('feed-sources:delete', (id): { deleted: boolean } => {
    const deleted = deps.store().remove(id)
    if (deleted) deps.changed()
    return { deleted }
  })

  handle('feed-sources:run-now', (id): Promise<FeedSourceRunResult> => deps.runNow(id))
}
