import { describeDropped, MISSING } from './island-files.js'
import { checkAsk, checkDroppedPaths, checkIslandAction, checkIslandView } from './island-ipc.js'

/**
 * The main process's side of the Viva island: the messages between the window, the desktop island
 * (desk-island.js) and here, and the shortcut that calls up the island's input from any app. Every message
 * is checked (island-ipc.js); the desktop island may only speak on its own channels, the window on its own.
 */
export const ASK_SHORTCUT = 'CommandOrControl+Shift+Space'
export const BUSY = '正在忙，完成后再问'
const NOT_SENT = '没能发送，请再试一次'

/**
 * @param {object} ipcMain
 * @param {{ desk: () => object | null, window: () => object | null, busy: () => boolean, showWindow: () => void }} deps
 */
export function registerIslandIpc(ipcMain, { desk, window, busy, showWindow }) {
  const fromDesk = (event) => {
    const island = desk()
    return island?.owns(event.sender) ? island : null
  }
  const toWindow = (action) => {
    const win = window()
    if (win && !win.isDestroyed()) win.webContents.send('island:action', action)
  }

  ipcMain.on('island:view', (event, raw) => {
    if (event.sender !== window()?.webContents) return
    const view = checkIslandView(raw)
    if (view) desk()?.setView(view)
  })

  const LOCAL = {
    rect: (island, { x, y, width, height }) => island.setIslandRect({ x, y, width, height }),
    drag: (island, { phase }) => (phase === 'start' ? island.startDrag() : island.endDrag()),
    input: (island) => island.openInput(),
    dismiss: (island) => island.closeInput(),
    open: (island) => {
      island.closeInput()
      showWindow()
    },
  }
  ipcMain.on('island:act', (event, raw) => {
    const island = fromDesk(event)
    const action = island && checkIslandAction(raw)
    if (!action) return
    if (Object.hasOwn(LOCAL, action.kind)) LOCAL[action.kind](island, action)
    else toWindow(action)
  })

  /** Files dropped on the island: what they are, or why they cannot be handed over. */
  ipcMain.handle('island:files', (event, raw) => {
    if (!fromDesk(event)) return { error: MISSING }
    const paths = checkDroppedPaths(raw)
    return paths ? describeDropped(paths) : { error: MISSING }
  })

  /** A question from the island's input goes to the window, which sends it as if typed there. */
  ipcMain.handle('island:ask', (event, raw) => {
    const island = fromDesk(event)
    const ask = island && checkAsk(raw)
    if (!ask) return { ok: false, error: NOT_SENT }
    if (busy()) return { ok: false, error: BUSY }
    const checked = ask.files.length ? describeDropped(ask.files) : { files: [] }
    if (checked.error) return { ok: false, error: checked.error }
    toWindow({ kind: 'ask', text: ask.text, files: ask.files })
    island.closeInput({ sent: true })
    return { ok: true }
  })
}

/**
 * The shortcut: with the window in front it goes to the window's own input; otherwise it opens the
 * desktop island's input.
 * @param {object} globalShortcut
 * @param {{ foreground: () => boolean, focusComposer: () => void, openInput: () => boolean, showWindow: () => void }} deps
 * @returns {boolean} false when another app holds the shortcut
 */
export function registerAskShortcut(globalShortcut, { foreground, focusComposer, openInput, showWindow }) {
  try {
    return globalShortcut.register(ASK_SHORTCUT, () => {
      if (foreground()) focusComposer()
      else if (!openInput()) showWindow()
    })
  } catch (err) {
    console.error('[island] could not register the shortcut:', err.message)
    return false
  }
}
