import { canOpen, listFolder, previewFile, resolveInside } from './workspace-files.js'

const MAX_PATH_CHARS = 1000

function checkPath(value) {
  if (typeof value !== 'string' || value.length > MAX_PATH_CHARS) throw new Error('invalid path')
  return value
}

/**
 * The 文件 tab's channels. Paths come from the page and are workspace paths; workspace-files.js keeps them
 * inside the workspace. A program or script is only shown in its folder, never opened.
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ root: () => string, shell: Pick<import('electron').Shell, 'openPath' | 'showItemInFolder'> }} deps
 */
export function registerFilesIpc(ipcMain, { root, shell }) {
  ipcMain.handle('files:list', (_event, rel) => listFolder(root(), checkPath(rel)))
  ipcMain.handle('files:preview', (_event, rel) => previewFile(root(), checkPath(rel)))
  ipcMain.handle('files:reveal', (_event, rel) => {
    shell.showItemInFolder(resolveInside(root(), checkPath(rel)))
  })
  ipcMain.handle('files:open', async (_event, rel) => {
    const file = resolveInside(root(), checkPath(rel))
    if (!canOpen(file)) throw new Error('这是程序或脚本，只能在文件夹中显示')
    const problem = await shell.openPath(file)
    if (problem) throw new Error(problem)
  })
}
