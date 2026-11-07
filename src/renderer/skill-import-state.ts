import type { ActionHandlers } from './action-types.ts'
import type { SkillScanView, SkillSourceView } from './capability-types.ts'

/**
 * 能力 · 技能 · 导入 (skill-import-ipc.ts): first where from (the folders found, or one the user picks), then what was
 * found there, checked, each ticked or not; 导入 copies those ticked. Pure, like the rest of state.ts.
 */
export const initialSkillImport = Object.freeze({
  open: false,
  sources: Object.freeze([]) as readonly SkillSourceView[],
  /** What the folder picked holds; null while where from is being chosen. */
  scan: null as SkillScanView | null,
  /** The entries ticked. */
  picks: Object.freeze([]) as readonly string[],
  busy: false,
  error: null as string | null,
})

const withImport = (state: State, changes: Partial<State['skillImport']>): State => ({ ...state, skillImport: { ...state.skillImport, ...changes } })
const scanOf = (state: State): SkillScanView | null => state.skillImport.scan as SkillScanView | null

export const SKILL_IMPORT_ACTIONS = {
  skill_import_open: (state, { sources }) => withImport(state, { ...initialSkillImport, open: true, sources }),
  skill_import_busy: (state) => withImport(state, { busy: true, error: null }),
  skill_import_scanned: (state, { scan }) => withImport(state, {
    busy: false, error: null, scan, picks: scan.candidates.filter((candidate) => candidate.picked).map((candidate) => candidate.entry),
  }),
  skill_import_back: (state) => withImport(state, { scan: null, picks: [], error: null }),
  /** One dsh could not load is never ticked. */
  skill_import_pick: (state, { entry, on }) => {
    const found = scanOf(state)?.candidates.find((candidate) => candidate.entry === entry)
    if (!found || found.status === 'blocked') return state
    const others = (state.skillImport.picks as readonly string[]).filter((pick) => pick !== entry)
    return withImport(state, { picks: on ? [...others, entry] : others })
  },
  /** message null: nothing to say (the folder dialog cancelled). */
  skill_import_failed: (state, { message }) => withImport(state, { busy: false, error: message }),
  skill_import_close: (state) => withImport(state, { ...initialSkillImport }),
} satisfies ActionHandlers

/** How many of those found go in as they are, put right, or not at all; and how many are ticked. */
export function importCounts(state: State): { ready: number, fixable: number, blocked: number, picked: number } {
  const candidates = scanOf(state)?.candidates ?? []
  const count = (status: string) => candidates.filter((candidate) => candidate.status === status).length
  return { ready: count('ready'), fixable: count('fixable'), blocked: count('blocked'), picked: state.skillImport.picks.length }
}
