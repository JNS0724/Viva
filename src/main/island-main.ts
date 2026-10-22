import { deskMenuTemplate } from './desk-menu.ts'
import { describeDropped, MISSING } from './island-files.ts'
import { checkAsk, checkDroppedPaths, checkIslandAction, checkIslandView } from './island-ipc.ts'

/**
 * The main process's side of the Viva island: the messages between the window, the desktop island
 * (desk-island.js) and here, and the shortcut that calls up the island's input from any app. Every message
 * is checked (island-ipc.js); the desktop island may only speak on its own channels, the window on its own.
 */
export const ASK_SHORTCUT = 'CommandOrControl+Shift+Space'
const NOT_SENT = '没能发送，请再试一次'

/**
 * @param {object} ipcMain
 * @param {{
 *   desk: () => object | null, window: () => object | null, showWindow: () => void,
 *   Menu: object, switchOff: () => void,
 * }} deps Menu: Electron's, for the island's right-click menu; switchOff: 不再显示桌面岛 in that menu
 */
export function registerIslandIpc(ipcMain, { desk, window, showWindow, Menu, switchOff }) {
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

  const openWindow = (island) => {
    island.closeInput()
    showWindow()
  }
  const menu = (island) => Menu.buildFromTemplate(deskMenuTemplate({
    working: island.working(),
    shortcut: ASK_SHORTCUT,
    ask: () => island.openInput(),
    open: () => openWindow(island),
    stop: () => toWindow({ kind: 'cancel' }),
    resetPlace: () => island.resetPlace(),
    hide: () => island.hideUntilAway(),
    switchOff,
  }))

  const LOCAL = {
    rect: (island, { x, y, width, height }) => island.setIslandRect({ x, y, width, height }),
    drag: (island, { phase }) => ({ start: island.startDrag, move: island.dragMove, end: island.endDrag })[phase](),
    input: (island) => island.openInput(),
    dismiss: (island) => island.closeInput(),
    open: openWindow,
    // Background tasks are on the window's 后台 page: the window comes forward on it (on the task, for a line).
    task: (island, action) => {
      toWindow(action)
      openWindow(island)
    },
    tasks: (island, action) => {
      toWindow(action)
      openWindow(island)
    },
    menu: (island) => island.popup(menu(island)),
    coached: (island) => island.markCoached(),
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

  /**
   * A question from the island's input goes to the window, which sends it as if typed there: while the agent
   * works, into its turn.
   */
  ipcMain.handle('island:ask', (event, raw) => {
    const island = fromDesk(event)
    const ask = island && checkAsk(raw)
    if (!ask) return { ok: false, error: NOT_SENT }
    const checked = ask.files.length ? describeDropped(ask.files) : { files: [] }
    if ('error' in checked) return { ok: false, error: checked.error }
    toWindow({ kind: 'ask', text: ask.text, files: ask.files, images: ask.images })
    island.closeInput({ sent: true })
    return { ok: true }
  })
}

/**
 * The shortcut: with the window closed to the tray it opens the desktop island's input; otherwise it goes to
 * the window's own input, bringing the window to the front if something covers it.
 * @param {object} globalShortcut
 * @param {{ foreground: () => boolean, focusComposer: () => void, openInput: () => boolean, showWindow: () => void }} deps
 * @returns {boolean} false when another app holds the shortcut
 */
export function registerAskShortcut(globalShortcut, { foreground, focusComposer, openInput, showWindow }) {
  try {
    return globalShortcut.register(ASK_SHORTCUT, () => {
      if (foreground()) focusComposer()
      else if (!openInput()) {
        showWindow()
        focusComposer()
      }
    })
  } catch (err: any) {
    console.error('[island] could not register the shortcut:', err.message)
    return false
  }
}
