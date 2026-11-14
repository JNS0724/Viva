import { t } from '../shared/i18n/translate.ts'
import type { ImportKind, ImportScanView, ImportSourceView, ServerView, SkillView } from './capability-types.ts'

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
  /** `pick`: the import it was asked in is still open, so the first brought in is picked. */
  const finished: Record<ImportKind, (done: unknown, pick: boolean) => void> = {
    skills: (answer, pick) => {
      const done = answer as SkillsDone
      dispatch({ type: 'extensions_saved', view: { skills: [...done.skills] }, notice: done.notice })
      const first = done.skills.find((skill) => skill.managed !== false && skill.name === done.imported[0])
      if (pick && first) dispatch({ type: 'capabilities_select', id: first.id })
    },
    mcp: (answer, pick) => {
      const done = answer as McpDone
      dispatch({ type: 'extensions_saved', view: { servers: [...done.servers] }, notice: done.notice })
      if (done.info) dispatch({ type: 'config_applied', info: done.info })
      if (pick && done.imported[0]) dispatch({ type: 'capabilities_select', id: done.imported[0] })
    },
  }
  // Every answer goes back with the import it was asked in (`flow`); one from an import since closed or replaced is let go.
  const fail = (flow: number, err: unknown) => dispatch({ type: 'import_failed', flow, message: errorMessage(err) })

  return {
    async openImport(kind: ImportKind) {
      dispatch({ type: 'import_opening', kind })
      const { flow } = getState().importFlow
      try {
        dispatch({ type: 'import_sources', flow, sources: await calls[kind].sources() as readonly ImportSourceView[] })
      } catch (err) {
        fail(flow, err)
      }
    },
    /** from: a place's id, or 'choose' for the folder dialog. */
    async scanImportSource(from: string) {
      const { kind, flow } = getState().importFlow
      if (!kind) return
      dispatch({ type: 'import_busy', flow })
      try {
        const scan = await calls[kind as ImportKind].scan(from) as ImportScanView | { cancelled: true }
        if ('cancelled' in scan) return dispatch({ type: 'import_failed', flow, message: null })
        dispatch({ type: 'import_scanned', flow, scan })
      } catch (err) {
        fail(flow, err)
      }
    },
    pickImport: (entry: string, on: boolean) => dispatch({ type: 'import_pick', entry, on }),
    backToImportSources: () => dispatch({ type: 'import_back' }),
    closeImport: () => dispatch({ type: 'import_close' }),
    async importPicked() {
      const { kind, scan, picks, busy, flow } = getState().importFlow
      if (!kind || !scan || !picks.length || busy) return
      dispatch({ type: 'import_busy', flow })
      try {
        const done = await calls[kind as ImportKind].run((scan as ImportScanView).scanId, [...picks]) as Changed | object
        if ('changed' in done) {
          dispatch({ type: 'import_scanned', flow, scan: done.scan })
          return dispatch({ type: 'import_failed', flow, message: t('capabilities.import.changed') })
        }
        // What was brought in is so whatever is open now; only the import it was asked in is closed and its first picked.
        const still = getState().importFlow.open && getState().importFlow.flow === flow
        if (still) dispatch({ type: 'import_close' })
        finished[kind as ImportKind](done, still)
      } catch (err) {
        fail(flow, err)
      }
    },
  }
}
