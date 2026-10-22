import fs from 'node:fs'
import { checkImages, IMAGE_LIMITS, mimeOfId } from '../shared/images.ts'

const GONE = '有张图片已经不在图片文件夹里了（可能被清空了），去掉它再发'
const BUSY = '助手正在工作，等这一轮结束再改'

/**
 * The window's and the desktop island's side of pictures: keeping one pasted, and in settings the folder's size,
 * opening it, emptying it and moving it (image-store.js). Moving changes where dsh keeps its copies too, so dsh
 * starts again on the new folder (`restart`).
 * @param {{ handle: (channel: string, listener: Function) => void }} ipcMain
 * @param {{
 *   store: ReturnType<import('./image-store.ts').createImageStore>,
 *   setDir: (dir: string) => void,
 *   chooseFolder: () => Promise<string | null>,
 *   reveal: (dir: string) => Promise<string>,
 *   isBusy: () => boolean,
 *   restart: () => Promise<unknown>,
 * }} deps
 */
export function registerImageIpc(ipcMain, { store, setDir, chooseFolder, reveal, isBusy, restart }) {
  const keep = (_event, bytes) => {
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) throw new Error('无效的图片')
    if (bytes.byteLength > IMAGE_LIMITS.bytes) throw new Error(`图片太大了（上限 ${IMAGE_LIMITS.bytes / 1024 / 1024} MB）`)
    return store.keep(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  }
  ipcMain.handle('images:keep', keep)
  ipcMain.handle('island:keep-image', keep)
  ipcMain.handle('images:usage', () => store.usage())
  ipcMain.handle('images:open-folder', async () => {
    const { dir } = store.usage()
    fs.mkdirSync(dir, { recursive: true })
    const problem = await reveal(dir)
    if (problem) throw new Error(problem)
  })
  ipcMain.handle('images:clear', () => {
    if (isBusy()) throw new Error(BUSY)
    store.clear()
    return store.usage()
  })
  ipcMain.handle('images:move', async () => {
    if (isBusy()) throw new Error(BUSY)
    const parent = await chooseFolder()
    if (!parent) return null
    setDir(store.moveTo(parent))
    await restart()
    return store.usage()
  })
}

/**
 * The pictures of a question, read for the model: base64, with their kind.
 * @returns {{ data: string, mimeType: string }[]}
 */
export function imagesForPrompt(store, images) {
  const checked = checkImages(images)
  if (!checked) throw new Error('invalid images')
  return checked.map(({ id }) => {
    const file = store.pathOf(id)
    if (!file) throw new Error(GONE)
    return { data: fs.readFileSync(file).toString('base64'), mimeType: mimeOfId(id) }
  })
}
