import { t } from '../shared/i18n/translate.ts'
import type { SkillScanView, SkillSourceView, SkillView } from './capability-types.ts'

/**
 * 能力 · 技能 · 导入 (skill-import-state.ts, skill-import-ipc.ts): the folders found to bring skills from, a scan of one
 * (or of a folder picked in the dialog), and the import of those ticked. What it did goes where every change on the
 * page goes (extensions_saved), with the skills as they are now, and the first one brought in is picked.
 */
type ImportAnswer = { imported: readonly string[], notice: string, skills: readonly SkillView[] }
/** What a skill ticked would go in as changed since it was shown: the folder as it is now, to look at again. */
type ChangedAnswer = { changed: true, scan: SkillScanView }

export function createSkillImportActions({ api, getState, dispatch, errorMessage }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage'>) {
  const fail = (err: unknown) => dispatch({ type: 'skill_import_failed', message: errorMessage(err) })

  return {
    async openSkillImport() {
      try {
        dispatch({ type: 'skill_import_open', sources: await api.skillSources() as readonly SkillSourceView[] })
      } catch (err) {
        dispatch({ type: 'extensions_failed', message: errorMessage(err) })
      }
    },
    /** from: a folder's id, or 'choose' for the folder dialog. */
    async scanSkillSource(from: string) {
      dispatch({ type: 'skill_import_busy' })
      try {
        const scan = await api.scanSkills(from) as SkillScanView | { cancelled: true }
        if ('cancelled' in scan) return dispatch({ type: 'skill_import_failed', message: null })
        dispatch({ type: 'skill_import_scanned', scan })
      } catch (err) {
        fail(err)
      }
    },
    pickSkill: (entry: string, on: boolean) => dispatch({ type: 'skill_import_pick', entry, on }),
    backToSkillSources: () => dispatch({ type: 'skill_import_back' }),
    closeSkillImport: () => dispatch({ type: 'skill_import_close' }),
    async importPickedSkills() {
      const { scan, picks, busy } = getState().skillImport
      if (!scan || !picks.length || busy) return
      dispatch({ type: 'skill_import_busy' })
      try {
        const done = await api.importSkills((scan as SkillScanView).scanId, [...picks]) as ImportAnswer | ChangedAnswer
        if ('changed' in done) {
          dispatch({ type: 'skill_import_scanned', scan: done.scan })
          return dispatch({ type: 'skill_import_failed', message: t('capabilities.import.changed') })
        }
        dispatch({ type: 'extensions_saved', view: { skills: [...done.skills] }, notice: done.notice })
        dispatch({ type: 'skill_import_close' })
        const first = done.skills.find((skill) => skill.managed !== false && skill.name === done.imported[0])
        if (first) dispatch({ type: 'capabilities_select', id: first.id })
      } catch (err) {
        fail(err)
      }
    },
  }
}
