import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Files dropped on the desktop island. They are not copied anywhere: the question names their paths, and
 * the agent reads them as it reads any file outside the workspace, asking the user first if its rules say so.
 * Only files can be handed over; a folder, or anything that is not there, is refused with a reason.
 */
export let NOT_A_FILE = t("main.island-files.folders.are.not.supported.here.yet.drop")
export let MISSING = t("main.island-files.file.not.found")

export interface DroppedFile { path: string, name: string, size: number }

/** @param paths absolute paths, as the system gave them for the drop */
export function describeDropped(paths: readonly string[]): { files: DroppedFile[] } | { error: string } {
  const files: DroppedFile[] = []
  for (const item of paths) {
    if (!path.isAbsolute(item)) return { error: MISSING }
    let stat: fs.Stats
    try {
      stat = fs.statSync(item)
    } catch {
      return { error: MISSING }
    }
    if (!stat.isFile()) return { error: NOT_A_FILE }
    files.push({ path: item, name: path.basename(item), size: stat.size })
  }
  return { files }
}

onLocaleChange(() => {
  NOT_A_FILE = t("main.island-files.folders.are.not.supported.here.yet.drop")
  MISSING = t("main.island-files.file.not.found")
})
