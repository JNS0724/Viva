import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
import { deskMenuTemplate } from './desk-menu.ts'
import { describeDropped, MISSING } from './island-files.ts'
import type { BrowserWindow, GlobalShortcut, IpcMainEvent, IpcMainInvokeEvent, Menu as ElectronMenu } from 'electron'
import type { createDeskIsland } from './desk-island.ts'
import type { IpcRegistry } from './ipc-contract.ts'
import { checkAsk, checkDroppedPaths, checkIslandAction, checkIslandView, type IslandAction } from './island-ipc.ts'

type DeskIsland = ReturnType<typeof createDeskIsland>

/**
 * The main process's side of the Viva island: the messages between the window, the desktop island
 * (desk-island.js) and here, and the shortcut that calls up the island's input from any app. Every message
 * is checked (island-ipc.js); the desktop island may only speak on its own channels, the window on its own.
 */
export const ASK_SHORTCUT = 'CommandOrControl+Shift+Space'
let NOT_SENT = t("main.island-main.could.not.send.please.try.again")

/** deps.Menu: Electron's, for the island's right-click menu; switchOff: 不再显示桌面岛 in that menu */
export function registerIslandIpc(ipcMain: IpcRegistry, { desk, window, showWindow, Menu, switchOff }: {
  desk: () => DeskIsland | null, window: () => BrowserWindow | null, showWindow: () => void,
  Menu: Pick<typeof ElectronMenu, 'buildFromTemplate'>, switchOff: () => void,
}) {
  const fromDesk = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    const island = desk()
    return island?.owns(event.sender) ? island : null
  }
  const toWindow = (action: IslandAction) => {
    const win = window()
    if (win && !win.isDestroyed()) win.webContents.send('island:action', action)
  }

  ipcMain.on('island:view', (event, raw) => {
    if (event.sender !== window()?.webContents) return
    const view = checkIslandView(raw)
    if (view) desk()?.setView(view)
  })

  const openWindow = (island: DeskIsland) => {
    island.closeInput()
    showWindow()
  }
  const menu = (island: DeskIsland) => Menu.buildFromTemplate(deskMenuTemplate({
    working: island.working(),
    shortcut: ASK_SHORTCUT,
    ask: () => island.openInput(),
    open: () => openWindow(island),
    stop: () => toWindow({ kind: 'cancel' }),
    resetPlace: () => island.resetPlace(),
    hide: () => island.hideUntilAway(),
    switchOff,
  }))

  // The actions come checked (checkIslandAction): each has the fields its kind needs, of their types.
  const LOCAL: Readonly<Record<string, (island: DeskIsland, action: any) => unknown>> = {
    rect: (island, { x, y, width, height }) => island.setIslandRect({ x, y, width, height }),
    drag: (island, { phase }: { phase: 'start' | 'move' | 'end' }) => ({ start: island.startDrag, move: island.dragMove, end: island.endDrag })[phase](),
    input: (island) => island.openInput(),
    dismiss: (island) => island.closeInput(),
    open: openWindow,
    // Background tasks are on the window's 后台 page: the window comes forward on it (on the task, for a line).
    task: (island, action: IslandAction) => {
      toWindow(action)
      openWindow(island)
    },
    tasks: (island, action: IslandAction) => {
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
 * @returns false when another app holds the shortcut
 */
export function registerAskShortcut(globalShortcut: Pick<GlobalShortcut, 'register'>, { foreground, focusComposer, openInput, showWindow }: {
  foreground: () => boolean, focusComposer: () => void, openInput: () => boolean, showWindow: () => void,
}): boolean {
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

onLocaleChange(() => {
  NOT_SENT = t("main.island-main.could.not.send.please.try.again")
})
