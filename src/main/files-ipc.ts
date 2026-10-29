import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs'
import { nativeFileApplications, openNativeFileApplication } from '@deepseek-ai/dsh-native-command'
import type { Shell } from 'electron'
import type { IpcRegistry } from './ipc-contract.ts'
import { canOpen, listFolder, previewFile, resolveInside } from './workspace-files.ts'

/** An app that opens a file, as dsh's native associations list it. */
type FileApp = { readonly id: string, readonly name: string, readonly default: boolean, readonly icon: string | null }

const MAX_PATH_CHARS = 1000
const MAX_APP_ID_CHARS = 1000
const APPS_TIMEOUT_MS = 5_000
const OPEN_TIMEOUT_MS = 15_000
/** Editors save in bursts; one announcement per burst. */
const CHANGE_SETTLE_MS = 300

function checkPath(value: unknown) {
  if (typeof value !== 'string' || value.length > MAX_PATH_CHARS) throw new Error('invalid path')
  return value
}

/** dsh's own cross-platform file associations (LaunchServices, Shell handlers, GIO). */
const DSH_NATIVE = {
  applications: (file: string): Promise<readonly FileApp[]> => nativeFileApplications(file, AbortSignal.timeout(APPS_TIMEOUT_MS)),
  openWith: (file: string, app: string): Promise<void> => openNativeFileApplication(file, app, AbortSignal.timeout(OPEN_TIMEOUT_MS)),
}

const watchFile = (file: string, onChange: () => void) => fs.watch(file, { persistent: false }, onChange)

/**
 * The 文件 tab's channels. Paths come from the page and are workspace paths; workspace-files.js keeps them
 * inside the workspace. A program or script is only shown in its folder, never opened, and lists no apps.
 */
export function registerFilesIpc(ipcMain: Pick<IpcRegistry, 'handle'>, { root, shell, notify, native = DSH_NATIVE, watch = watchFile }: {
  root: () => string,
  shell: Pick<Shell, 'openPath' | 'showItemInFolder'>,
  notify: (event: { type: 'files_changed', path: string }) => void,
  native?: { applications: (file: string) => Promise<readonly FileApp[]>, openWith: (file: string, app: string) => Promise<void> },
  watch?: (file: string, onChange: () => void) => { close: () => void },
}) {
  let watched: { close: () => void } | null = null
  let settle: ReturnType<typeof setTimeout> | undefined

  ipcMain.handle('files:list', (_event, rel) => listFolder(root(), checkPath(rel)))
  ipcMain.handle('files:preview', (_event, rel, offset = 0) => previewFile(root(), checkPath(rel), { offset }))
  ipcMain.handle('files:reveal', (_event, rel) => {
    shell.showItemInFolder(resolveInside(root(), checkPath(rel)))
  })

  /** The apps registered for the file, the system default marked; none for a program. */
  ipcMain.handle('files:apps', async (_event, rel) => {
    const file = resolveInside(root(), checkPath(rel))
    if (!canOpen(file)) return []
    try {
      return (await native.applications(file)).map(({ id, name, default: isDefault, icon }) => ({ id, name, default: isDefault, icon }))
    } catch (err: any) {
      console.error('[files] could not list the apps for a file:', err.message)
      return []
    }
  })

  /** Opens with the given app (one of files:apps), or with the system default. */
  ipcMain.handle('files:open', async (_event, rel, app: unknown = null) => {
    const file = resolveInside(root(), checkPath(rel))
    if (!canOpen(file)) throw new Error(t("main.files-ipc.this.is.a.program.or.script.it"))
    if (app !== null) {
      if (typeof app !== 'string' || !app || app.length > MAX_APP_ID_CHARS) throw new Error('invalid app')
      return native.openWith(file, app)
    }
    const problem = await shell.openPath(file)
    if (problem) throw new Error(problem)
  })

  /** A picture a Markdown file in the workspace shows. */
  ipcMain.handle('files:image', (_event, rel) => {
    const preview = previewFile(root(), checkPath(rel))
    if (preview.kind !== 'image') throw new Error(t("main.files-ipc.this.is.not.an.image.or.it"))
    return preview.dataUrl
  })

  /** Watches the file on preview, one at a time (null stops); a change is announced to the page. */
  ipcMain.handle('files:watch', (_event, rel) => {
    watched?.close()
    watched = null
    clearTimeout(settle)
    if (rel === null) return
    const path = checkPath(rel)
    watched = watch(resolveInside(root(), path), () => {
      clearTimeout(settle)
      settle = setTimeout(() => notify({ type: 'files_changed', path }), CHANGE_SETTLE_MS)
    })
  })
}
