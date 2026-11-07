import type { ActionHandlers } from './action-types.ts'
import type { ImportKind, ImportScanView, ImportSourceView } from './capability-types.ts'

/**
 * 能力 · 导入 (skill-import-ipc.ts, mcp-import-ipc.ts): bringing skills or MCP servers in. First where from (the
 * places found, or a folder picked), then what is there, checked, each ticked or not; 导入 brings in those ticked.
 * One flow for both kinds, which differ only in their calls and words. Pure, like the rest of state.ts.
 */
export const initialImportFlow = Object.freeze({
  open: false,
  kind: null as ImportKind | null,
  sources: Object.freeze([]) as readonly ImportSourceView[],
  /** What the place picked holds; null while where from is being chosen. */
  scan: null as ImportScanView | null,
  /** The entries ticked. */
  picks: Object.freeze([]) as readonly string[],
  busy: false,
  error: null as string | null,
})

const withImport = (state: State, changes: Partial<State['importFlow']>): State => ({ ...state, importFlow: { ...state.importFlow, ...changes } })
const scanOf = (state: State): ImportScanView | null => state.importFlow.scan as ImportScanView | null

/** The import open on `kind`'s tab, or none. */
export const importing = (state: State, kind: ImportKind): boolean => state.importFlow.open && state.importFlow.kind === kind

export const IMPORT_FLOW_ACTIONS = {
  import_open: (state, { kind, sources }) => withImport(state, { ...initialImportFlow, open: true, kind, sources }),
  import_busy: (state) => withImport(state, { busy: true, error: null }),
  import_scanned: (state, { scan }) => withImport(state, {
    busy: false, error: null, scan, picks: scan.candidates.filter((candidate) => candidate.picked).map((candidate) => candidate.entry),
  }),
  import_back: (state) => withImport(state, { scan: null, picks: [], error: null }),
  /** One that cannot go in is never ticked. */
  import_pick: (state, { entry, on }) => {
    const found = scanOf(state)?.candidates.find((candidate) => candidate.entry === entry)
    if (!found || found.status === 'blocked') return state
    const others = (state.importFlow.picks as readonly string[]).filter((pick) => pick !== entry)
    return withImport(state, { picks: on ? [...others, entry] : others })
  },
  /** message null: nothing to say (the folder dialog cancelled). */
  import_failed: (state, { message }) => withImport(state, { busy: false, error: message }),
  import_close: (state) => withImport(state, { ...initialImportFlow }),
} satisfies ActionHandlers

/** How many of those found go in as they are, put right, or not at all; and how many are ticked. */
export function importCounts(state: State): { ready: number, fixable: number, blocked: number, picked: number } {
  const candidates = scanOf(state)?.candidates ?? []
  const count = (status: string) => candidates.filter((candidate) => candidate.status === status).length
  return { ready: count('ready'), fixable: count('fixable'), blocked: count('blocked'), picked: state.importFlow.picks.length }
}
