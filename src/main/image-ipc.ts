import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs'
import { checkImages, IMAGE_LIMITS, mimeOfId } from '../shared/images.ts'
import type { createImageStore } from './image-store.ts'
import type { IpcRegistry } from './ipc-contract.ts'

let GONE = t("main.image-ipc.an.image.is.missing.from.the.image")
let BUSY = t("main.image-ipc.wait.for.this.turn.to.finish.before")

/**
 * The window's and the desktop island's side of pictures: keeping one pasted, and in settings the folder's size,
 * opening it, emptying it and moving it (image-store.js). Moving changes where dsh keeps its copies too, so dsh
 * starts again on the new folder (`restart`).
 */
export function registerImageIpc(ipcMain: Pick<IpcRegistry, 'handle'>, { store, setDir, chooseFolder, reveal, isBusy, restart }: {
  store: ReturnType<typeof createImageStore>,
  setDir: (dir: string) => void,
  chooseFolder: () => Promise<string | null>,
  reveal: (dir: string) => Promise<string>,
  isBusy: () => boolean,
  restart: () => Promise<unknown>,
}) {
  const keep = (_event: unknown, bytes: unknown) => {
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) throw new Error(t("main.image-ipc.invalid.image"))
    if (bytes.byteLength > IMAGE_LIMITS.bytes) throw new Error(t("main.image-ipc.image.is.too.large.maximum.mb", { value1: IMAGE_LIMITS.bytes / 1024 / 1024 }))
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
 */
export function imagesForPrompt(store: Pick<ReturnType<typeof createImageStore>, 'pathOf'>, images: unknown): Array<{ data: string, mimeType: string }> {
  const checked = checkImages(images)
  if (!checked) throw new Error('invalid images')
  return checked.map(({ id }) => {
    const file = store.pathOf(id)
    const mimeType = mimeOfId(id)
    if (!file || !mimeType) throw new Error(GONE)
    return { data: fs.readFileSync(file).toString('base64'), mimeType }
  })
}

onLocaleChange(() => {
  GONE = t("main.image-ipc.an.image.is.missing.from.the.image")
  BUSY = t("main.image-ipc.wait.for.this.turn.to.finish.before")
})
