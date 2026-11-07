import { t } from '../shared/i18n/translate.ts'
import type { ImportKind, ImportScanView, ImportSourceView, ServerView, SkillView } from './capability-types.ts'
import { isBusy } from './state.ts'

/**
 * 能力 · 导入 (import-flow-state.ts): the places found to bring skills (skill-import-ipc.ts) or MCP servers
 * (mcp-import-ipc.ts) in from, a scan of one, and the import of those ticked. The kinds differ only in their calls and
 * in what a finished import does to the page: the list as it is now and what was done (extensions_saved), the
 * servers attached again said (config_applied), and the first one brought in picked.
 */
type Changed = { changed: true, scan: ImportScanView }
type SkillsDone = { imported: readonly string[], notice: string, skills: readonly SkillView[] }
type McpDone = { imported: readonly string[], notice: string, servers: readonly ServerView[], info?: AgentInfo | null }

export function createImportFlowActions({ api, getState, dispatch, errorMessage }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage'>) {
  const calls: Record<ImportKind, { sources: () => Promise<unknown>, scan: (from: string) => Promise<unknown>, run: (scanId: string, picks: string[]) => Promise<unknown> }> = {
    skills: { sources: () => api.skillSources(), scan: (from) => api.scanSkills(from), run: (scanId, picks) => api.importSkills(scanId, picks) },
    mcp: { sources: () => api.mcpSources(), scan: (from) => api.scanMcp(from), run: (scanId, picks) => api.importMcp(scanId, picks) },
  }
  const finished: Record<ImportKind, (done: unknown) => void> = {
    skills: (answer) => {
      const done = answer as SkillsDone
      dispatch({ type: 'extensions_saved', view: { skills: [...done.skills] }, notice: done.notice })
      const first = done.skills.find((skill) => skill.managed !== false && skill.name === done.imported[0])
      if (first) dispatch({ type: 'capabilities_select', id: first.id })
    },
    mcp: (answer) => {
      const done = answer as McpDone
      dispatch({ type: 'extensions_saved', view: { servers: [...done.servers] }, notice: done.notice })
      if (done.info) dispatch({ type: 'config_applied', info: done.info })
      if (done.imported[0]) dispatch({ type: 'capabilities_select', id: done.imported[0] })
    },
  }
  const fail = (err: unknown) => dispatch({ type: 'import_failed', message: errorMessage(err) })

  return {
    async openImport(kind: ImportKind) {
      try {
        dispatch({ type: 'import_open', kind, sources: await calls[kind].sources() as readonly ImportSourceView[] })
      } catch (err) {
        dispatch({ type: 'extensions_failed', message: errorMessage(err) })
      }
    },
    /** from: a place's id, or 'choose' for the folder dialog. */
    async scanImportSource(from: string) {
      const kind = getState().importFlow.kind as ImportKind | null
      if (!kind) return
      dispatch({ type: 'import_busy' })
      try {
        const scan = await calls[kind].scan(from) as ImportScanView | { cancelled: true }
        if ('cancelled' in scan) return dispatch({ type: 'import_failed', message: null })
        dispatch({ type: 'import_scanned', scan })
      } catch (err) {
        fail(err)
      }
    },
    pickImport: (entry: string, on: boolean) => dispatch({ type: 'import_pick', entry, on }),
    backToImportSources: () => dispatch({ type: 'import_back' }),
    closeImport: () => dispatch({ type: 'import_close' }),
    async importPicked() {
      const { kind, scan, picks, busy } = getState().importFlow
      if (!kind || !scan || !picks.length || busy) return
      // Changing servers attaches the session again, which would cut a running turn short.
      if (kind === 'mcp' && isBusy(getState())) return dispatch({ type: 'import_failed', message: t('extension-actions.stop.the.current.task.before.changing.mcp') })
      dispatch({ type: 'import_busy' })
      try {
        const done = await calls[kind as ImportKind].run((scan as ImportScanView).scanId, [...picks]) as Changed | object
        if ('changed' in done) {
          dispatch({ type: 'import_scanned', scan: done.scan })
          return dispatch({ type: 'import_failed', message: t('capabilities.import.changed') })
        }
        dispatch({ type: 'import_close' })
        finished[kind as ImportKind](done)
      } catch (err) {
        fail(err)
      }
    },
  }
}
