import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
import { deskMenuTemplate } from './desk-menu.ts'
import { describeDropped, MISSING } from './island-files.ts'
import type { BrowserWindow, GlobalShortcut, IpcMainEvent, IpcMainInvokeEvent, Menu as ElectronMenu } from 'electron'
import type { createDeskIsland } from './desk-island.ts'
import type { IpcRegistry } from '../shared/ipc-contract.ts'
import { checkAsk, checkDroppedPaths, checkIslandAction, checkIslandView, type IslandAction } from './island-ipc.ts'
import { createComposerDraftStore } from '../shared/composer-draft.ts'
import { checkImages } from '../shared/images.ts'
import { randomUUID } from 'node:crypto'

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
  const drafts = createComposerDraftStore(snapshot => {
    const main = window()
    if (main && !main.isDestroyed()) main.webContents.send('draft:changed', snapshot)
    desk()?.sendDraft(snapshot)
  })
  const receipts = new Map<string, { finish: (result: { ok: boolean, error?: string }) => void, timer: ReturnType<typeof setTimeout> }>()
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
    if (view) {
      if (typeof view.target?.key === 'string' && view.target.key.length <= 1000) drafts.select(view.target.key, view.target.inheritDraft === true)
      desk()?.setView(view)
    }
  })
  const source = (event: IpcMainEvent | IpcMainInvokeEvent) => event.sender === window()?.webContents ? 'main' : fromDesk(event) ? 'desk' : null
  ipcMain.handle('draft:get', event => source(event) ? drafts.snapshot() : null)
  ipcMain.on('draft:update', (event, snapshot) => {
    const host = source(event)
    if (!host || !checkImages(snapshot.images)) return
    const result = drafts.update(host, snapshot)
    if (!result.ok) event.sender.send('draft:changed', result.draft)
  })
  ipcMain.handle('draft:append-image', (event, key, image) => {
    if (source(event) && checkImages([image])) drafts.appendImage(key, image)
  })
  ipcMain.handle('draft:append-files', (event, key, paths) => {
    if (!source(event) || !checkDroppedPaths(paths)) return
    const checked = describeDropped(paths)
    if (!('error' in checked)) drafts.appendFiles(key, checked.files)
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
    placeAt: corner => island.placeAt(corner),
    hide: () => island.hideUntilAway(),
    switchOff,
  }))

  // The actions come checked (checkIslandAction): each has the fields its kind needs, of their types.
  const LOCAL: Readonly<Record<string, (island: DeskIsland, action: any) => unknown>> = {
    rect: (island, { x, y, width, height, version, ready, regions }) => island.setIslandRect({ x, y, width, height }, version, ready, regions),
    drag: (island, { phase, x, y }) => {
      if (phase === 'start') island.startDrag(x === undefined ? undefined : { x, y })
      else if (phase === 'move') island.dragMove()
      else island.endDrag(phase === 'cancel')
    },
    toggle: island => island.togglePanel(),
    panel: (island, { panel }) => island.openPanel(panel),
    place: (island, { corner }) => island.placeAt(corner),
    input: (island) => island.openInput(),
    dismiss: (island) => island.closeInput(),
    open: openWindow,
    settings: (island) => {
      toWindow({ kind: 'settings' })
      openWindow(island)
    },
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
  ipcMain.on('island:ask-result', (event, receiptId, result) => {
    if (event.sender !== window()?.webContents) return
    const receipt = receipts.get(receiptId)
    if (!receipt) return
    clearTimeout(receipt.timer); receipts.delete(receiptId); receipt.finish(result)
  })
  ipcMain.handle('island:ask', (event, raw) => {
    const island = fromDesk(event)
    const ask = island && checkAsk(raw)
    if (!ask) return { ok: false, error: NOT_SENT }
    const checked = ask.files.length ? describeDropped(ask.files) : { files: [] }
    if ('error' in checked) return { ok: false, error: checked.error }
    const snapshot = drafts.snapshot()
    const target = raw.draft as { key?: unknown, version?: unknown } | undefined
    if (!target || target.key !== snapshot.key || target.version !== snapshot.version || snapshot.owner !== 'desk') return { ok: false, error: NOT_SENT }
    const receiptId = randomUUID()
    return new Promise<{ ok: boolean, error?: string }>(resolve => {
      const timer = setTimeout(() => { receipts.delete(receiptId); resolve({ ok: false, error: NOT_SENT }) }, 10_000)
      receipts.set(receiptId, { timer, finish: result => {
        if (result.ok) { drafts.clear(snapshot); island.closeInput({ sent: true }) }
        resolve(result)
      } })
      toWindow({ kind: 'ask', text: ask.text, files: ask.files, images: ask.images, targetKey: snapshot.key, receiptId, expiresAt: Date.now() + 10_000 })
    })
  })
  return { ownDraft: drafts.own }
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
