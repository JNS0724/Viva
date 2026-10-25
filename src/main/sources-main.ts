import fs from 'node:fs'
import path from 'node:path'
import { shortPath } from './dsh-mcp-import.ts'
import type { IpcRegistry } from './ipc-contract.ts'
import type { Encryption } from './settings-store.ts'
import { listSourceFolders, type SourceFolder } from './source-folders.ts'
import { createSourcePoller } from './source-poller.ts'
import { checkSource, pollSource, type RunOptions } from './source-run.ts'
import { clearLeftovers } from './source-install.ts'
import { createSourceSettings } from './source-settings.ts'
import { openSourcesDb } from './sources-db.ts'
import { registerSourcesIpc } from './sources-ipc.ts'

/**
 * Message sources, put together at launch: the sources folder (userData/sources, one folder per source), what
 * the user set for each (source-settings.json), what they handed in (sources.db), and the poller that asks the
 * switched-on ones for new messages. Each source keeps its own files under userData/source-data/<id>.
 */
export function openSources({ userData, crypto, ipcMain, openPath, chooseFolder, trash, onError, onMessages = () => {} }: {
  userData: string
  crypto: Encryption
  ipcMain: Pick<IpcRegistry, 'handle'>
  /** Opens a folder in the system's file manager; resolves to an error message, '' when it worked. */
  openPath: (dir: string) => Promise<string>
  /** The system's folder dialog, for installing a source; null when the user cancels. */
  chooseFolder: () => Promise<string | null>
  trash: (dir: string) => Promise<void>
  onError: (err: Error) => void
  /** New messages came in: background preparation judges them in its next window. */
  onMessages?: () => void
}) {
  const root = path.join(userData, 'sources')
  clearLeftovers(root)
  const db = openSourcesDb({ file: path.join(userData, 'sources.db') })
  const settings = createSourceSettings({ file: path.join(userData, 'source-settings.json'), crypto, onError })
  const dataDirOf = (id: string) => path.join(userData, 'source-data', id)
  const runOptions = (folder: SourceFolder): RunOptions => ({ dataDir: dataDirOf(folder.manifest.id) })
  const list = () => listSourceFolders(root)
  const poller = createSourcePoller({
    folders: () => list().sources,
    settings,
    db,
    poll: (folder, config, cursor) => pollSource(folder, config, cursor, runOptions(folder)),
    onRun: (id, outcome) => {
      if ('problem' in outcome) onError(new Error(`source ${id}: ${outcome.problem}`))
      else if (outcome.added) onMessages()
    },
  })
  registerSourcesIpc(ipcMain, {
    list,
    root,
    label: (dir) => shortPath(dir),
    settings,
    db,
    poller,
    check: (folder, config) => checkSource(folder, config, runOptions(folder)),
    openFolder: async () => {
      fs.mkdirSync(root, { recursive: true })
      const problem = await openPath(root)
      if (problem) throw new Error(problem)
    },
    chooseFolder,
    trash,
    dropData: (id) => fs.rmSync(dataDirOf(id), { recursive: true, force: true }),
  })
  poller.refresh({ launching: true })
  return {
    db,
    /** The computer woke: the sources' timers slept with it. */
    wakeUp: () => poller.wakeUp(),
    close() {
      poller.stop()
      db.close()
    },
  }
}
