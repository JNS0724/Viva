import { t } from '../shared/i18n/translate.ts'
import { handlerOf, type IpcRegistry } from '../shared/ipc-contract.ts'
import { shortPath } from './dsh-mcp-import.ts'
import { importCandidates, scanSkills, type Candidate, type SkillSource } from './skill-import.ts'
import { listSkills, type skillRoots } from './skills.ts'

/**
 * IPC for bringing skills in (能力 · 技能 · 导入, skill-import.ts): the folders found to bring them from, a scan of one
 * (or of a folder the user picks), and the import of those ticked. The window names a folder by the id it was given
 * and a scan by its id, never by a path. The import scans that folder again, so it acts on what is there now; if a
 * skill ticked would go in under another name than the one shown, or not at all, nothing is copied and the new scan
 * goes back to be looked at again.
 */
type Roots = ReturnType<typeof skillRoots>

/** A candidate as the window sees it: no path. */
const candidateView = ({ source: _source, ...rest }: Candidate) => rest

export function registerSkillImportIpc(ipcMain: Pick<IpcRegistry, 'handle'>, deps: {
  roots: () => Roots,
  sources: () => SkillSource[],
  /** The system's folder dialog; null when the user cancels. */
  chooseDir: () => Promise<string | null>,
  newId?: () => string,
}) {
  const { roots, sources, chooseDir, newId = () => String(Date.now()) } = deps
  const handle = handlerOf(ipcMain)
  /** The folder last scanned, by its scan id, and what the window was shown of it. */
  let scanned: { id: string, dir: string, label: string, candidates: readonly Candidate[] } | null = null
  const scanView = () => ({ scanId: scanned!.id, label: scanned!.label, candidates: scanned!.candidates.map(candidateView) })

  const userRoot = () => {
    const root = roots().find((one) => one.managed)
    if (!root) throw new Error(t('main.skill-import.no.folder'))
    return root
  }
  /** Names Viva's skills folder has: those of its skills, and its entries, which a copy may not take. */
  const taken = () => new Set(listSkills(roots()).filter((skill) => skill.managed).flatMap((skill) => [skill.name, skill.id.split(':')[1].replace(/\.md$/i, '')]))

  handle('ext:skill-sources', () => sources().map(({ dir, ...source }) => ({ ...source, where: shortPath(dir) })))

  handle('ext:scan-skills', async (from) => {
    const found = sources().find((source) => source.id === from)
    const dir = from === 'choose' ? await chooseDir() : found?.dir
    if (!dir) {
      if (from !== 'choose') throw new Error(t('main.skill-import.no.source'))
      return { cancelled: true }
    }
    scanned = { id: newId(), dir, label: found?.label ?? shortPath(dir), candidates: scanSkills(dir, taken()) }
    return scanView()
  })

  /** Whether every one ticked would go in as it was shown: the same name, still able to. */
  const asShown = (fresh: readonly Candidate[], picks: readonly string[]) => picks.every((entry) => {
    const shown = scanned!.candidates.find((candidate) => candidate.entry === entry)
    const now = fresh.find((candidate) => candidate.entry === entry)
    return shown && now && now.status !== 'blocked' && now.name === shown.name && now.status === shown.status
  })

  handle('ext:import-skills', (scanId, picks) => {
    if (!scanned || scanned.id !== scanId) throw new Error(t('main.skill-import.scan.again'))
    const fresh = scanSkills(scanned.dir, taken())
    if (!asShown(fresh, picks)) {
      scanned = { ...scanned, id: newId(), candidates: fresh }
      return { changed: true, scan: scanView() }
    }
    const result = importCandidates(fresh, picks, userRoot().dir)
    const notice = [
      result.imported.length ? t('main.skill-import.imported', { count: result.imported.length, names: result.imported.join('、') }) : '',
      ...result.failed.map((failure) => failure.reason),
    ].filter(Boolean).join(' ')
    return { ...result, notice, skills: listSkills(roots()) }
  })
}
