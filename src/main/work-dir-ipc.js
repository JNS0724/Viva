import { forgetDir, sameDir, withRecent, workDirProblem } from './work-dir.ts'

/**
 * IPC for the working directory the user picks (single-conversation design). The window shows it and asks;
 * the main process checks every folder (work-dir.js), asks for a confirmation the first time a folder is used,
 * and switches by going on in a new session there (the fork in `switchTo`), never while a turn runs.
 * Kept in preferences.json as `workDirs`: the folders used lately, and the ones the user confirmed.
 * @param {{ handle: (channel: string, listener: Function) => void }} ipcMain
 * @param {{
 *   current: () => string, defaultDir: string,
 *   preferences: { get: () => { workDirs: { recent: string[], trusted: string[] } }, set: (key: string, value: object) => void },
 *   chooseFolder: () => Promise<string | null>, isBusy: () => boolean, switchTo: (dir: string) => Promise<object>,
 *   reveal?: (dir: string) => Promise<unknown>, platform?: string, problemOf?: (dir: string) => string | null,
 * }} deps reveal: opens the folder in Finder or Explorer
 */
export function registerWorkDirIpc(ipcMain, deps) {
  const { current, defaultDir, preferences, chooseFolder, isBusy, switchTo, reveal = async () => {}, platform = process.platform, problemOf = workDirProblem } = deps
  const handle = (channel, listener) => ipcMain.handle(channel, (_event, ...args) => listener(...args))
  // preferences.json is read as written by an earlier run, or by hand: only lists of paths pass.
  const paths = (list) => (Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item.length > 0) : [])
  const saved = () => {
    const stored = preferences.get().workDirs
    return { recent: paths(stored?.recent), trusted: paths(stored?.trusted) }
  }
  const isDefault = (dir) => sameDir(dir, defaultDir, platform)
  const state = () => ({ current: current(), defaultDir, isDefault: isDefault(current()), recent: saved().recent })

  handle('workdir:get', state)
  handle('workdir:choose', () => chooseFolder())
  /** The folder in use, in Finder or Explorer; only ever the one in use, never a path the window names. */
  handle('workdir:reveal', async () => {
    await reveal(current())
  })

  handle('workdir:switch', async (dir, options = {}) => {
    if (typeof dir !== 'string' || dir.length > 4096) throw new Error('invalid working directory')
    // The app's own folder is always fine; any other is checked as the user picked it.
    const problem = isDefault(dir) ? null : problemOf(dir)
    if (problem) return { ok: false, problem }
    if (sameDir(dir, current(), platform)) return { ok: true, unchanged: true, state: state() }
    if (isBusy()) return { ok: false, reason: 'busy' }
    const { recent, trusted } = saved()
    const known = isDefault(dir) || trusted.some((item) => sameDir(item, dir, platform))
    if (!known && options?.confirmed !== true) return { ok: false, needsConfirm: true, dir }
    const info = await switchTo(dir)
    preferences.set('workDirs', {
      recent: withRecent(recent, dir, platform),
      trusted: known ? trusted : [...forgetDir(trusted, dir, platform), dir],
    })
    return { ok: true, info, state: state() }
  })

  /** Off the list, and asked about again the next time it is picked. */
  handle('workdir:forget', (dir) => {
    if (typeof dir !== 'string') throw new Error('invalid working directory')
    const { recent, trusted } = saved()
    preferences.set('workDirs', { recent: forgetDir(recent, dir, platform), trusted: forgetDir(trusted, dir, platform) })
    return state()
  })
}
