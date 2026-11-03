import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, BrowserWindow, dialog, globalShortcut, ipcMain as electronIpcMain, Menu, nativeImage, Notification, powerMonitor, protocol, safeStorage, screen, shell, Tray } from 'electron'
import { createBackend } from '../backend/compose.ts'
import type { HostCapabilities, HostEvent } from '../backend/host.ts'
import { APP_ROOT, CODE_ROOT } from './config.ts'
import { createDeskIsland } from './desk-island.ts'
import { leaveFullScreen } from './full-screen.ts'
import { IMAGE_SCHEME_PRIVILEGES, registerImageProtocol } from './image-protocol.ts'
import { checkedIpc } from './ipc-contract.ts'
import { ASK_SHORTCUT, registerAskShortcut, registerIslandIpc } from './island-main.ts'
import type { Notice } from './notice-plan.ts'
import { createTray } from './tray.ts'
import { installAutomationDriver } from './automation-driver.ts'
import { devIcon, windowChrome, windowSize } from './window-options.ts'

/**
 * The desktop shell (docs/backend-split-design.md D1, D2): the app's lifecycle, the window, the tray, the desktop
 * island, the shortcut, notifications, dialogs and the system shell, offered to the backend as HostCapabilities
 * (src/backend/host.ts). Everything else is the backend's (src/backend/compose.ts).
 */
const automationMode = app.commandLine.hasSwitch('enable-smoke-test-driver')
// A standard alternate profile works for automation and separate user profiles alike.
const profileDirectory = app.commandLine.getSwitchValue('user-data-dir')
if (automationMode && !profileDirectory) throw new Error('External automation requires an explicit --user-data-dir')
if (profileDirectory) {
  const directory = path.resolve(profileDirectory)
  fs.mkdirSync(directory, { recursive: true })
  app.setPath('userData', directory)
}

/** Every channel the pages send on goes through the contract's check first (ipc-contract.ts). */
const ipcMain = checkedIpc(electronIpcMain, { onRefused: (_channel, problem) => console.error('[ipc] refused:', problem) })

/** Notifications shown and not yet clicked or closed: kept, or they may be collected before a click reaches them. */
const shownNotices = new Set<Notification>()
/** How long a shown notification is kept for its click. */
const NOTICE_KEEP_MS = 60 * 60 * 1000
/** Started with the computer (开机启动): the window stays hidden, Viva in the tray. */
const startedHidden = process.argv.includes('--hidden') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin)

let win: BrowserWindow | null = null
/** The island on the desktop, shown while the window is in the background (desk-island.ts). */
let desk: ReturnType<typeof createDeskIsland> | null = null
/** False in smoke runs, which turn the desktop island on only while they check it. */
let deskAllowed = true
/** The tray icon, made the first time the window is closed to it (tray.ts). */
let tray: ReturnType<typeof createTray> | null = null
/** Ready follow-ups, for the tray, which may be made after the count changed. */
let pendingFollowups = 0
/** Whether the shortcut that opens the island's input is ours (another app may hold it); null before it is tried. */
let shortcutHeld: ReturnType<typeof registerAskShortcut> | null = null

/** The window, for what happens only while it is open: its dialogs, the shortcut's focus, closing it to the tray. */
function mainWindow(): BrowserWindow {
  if (!win || win.isDestroyed()) throw new Error('the window is not open')
  return win
}

/** Brings the window to the front: from the desktop island, the tray, the Dock or a second launch. */
function showWindow() {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  if (process.platform === 'darwin') app.focus({ steal: true })
  win.focus()
}

const windowInFront = () => Boolean(win && !win.isDestroyed() && win.isFocused() && win.isVisible() && !win.isMinimized())

/** The 后台 page, from a notification or the tray: the window in front, on that page. */
function openTasksPage() {
  showWindow()
  if (win && !win.isDestroyed()) win.webContents.send('island:action', { kind: 'tasks' })
}

/** A follow-up's notice as a system notification; clicked, it opens the 后台 page. */
function showNotice(notice: Notice, opened: (afterMs: number) => void) {
  // Native Windows notifications may register/update a Start-menu shortcut for
  // our app ID. Automated smoke runs must not point that shortcut at a QA binary.
  // Notification planning/delivery is tested with injected notifiers separately.
  if (automationMode) return
  if (!Notification.isSupported()) return
  const shown = new Notification({ title: notice.title, body: notice.body })
  const shownAt = Date.now()
  shownNotices.add(shown)
  const done = () => shownNotices.delete(shown)
  shown.on('click', () => {
    done()
    // How long it took the user to open it: the week of self-use asks whether notices come at the right time.
    opened(Date.now() - shownAt)
    openTasksPage()
  })
  shown.on('close', done)
  // Some systems never say a notification closed: let it go after a while.
  setTimeout(done, NOTICE_KEEP_MS).unref?.()
  shown.show()
}

const folderOf = async (options: Electron.OpenDialogOptions) => {
  const result = await dialog.showOpenDialog(mainWindow(), options)
  return result.canceled ? null : result.filePaths[0] ?? null
}

/** What the backend may ask of this desktop. */
const host: HostCapabilities = {
  paths: { userData: app.getPath('userData'), documents: app.getPath('documents'), appData: app.getPath('appData'), home: os.homedir() },
  packaged: app.isPackaged,
  automation: automationMode,
  locale: () => app.getLocale(),
  secrets: safeStorage,
  dialogs: {
    chooseFolder: ({ title, createDirectory = false, defaultPath, showHidden = false }) => folderOf({
      title, ...(defaultPath ? { defaultPath } : {}),
      properties: ['openDirectory', ...(createDirectory ? ['createDirectory' as const] : []), ...(showHidden ? ['showHiddenFiles' as const] : [])],
    }),
    chooseFiles: async ({ title, multiple = false }) => {
      const result = await dialog.showOpenDialog(mainWindow(), { title, properties: ['openFile', ...(multiple ? ['multiSelections' as const] : [])] })
      return result.canceled ? null : result.filePaths
    },
    saveFile: async ({ title, defaultPath, filters }) => {
      const result = await dialog.showSaveDialog(mainWindow(), { title, defaultPath, ...(filters ? { filters } : {}) })
      return result.canceled ? null : result.filePath ?? null
    },
  },
  shell: {
    openExternal: (url) => shell.openExternal(url),
    openPath: (dir) => shell.openPath(dir),
    showItemInFolder: (file) => shell.showItemInFolder(file),
    trash: (file) => shell.trashItem(file),
  },
  notify: showNotice,
  power: { idleSeconds: () => powerMonitor.getSystemIdleTime() },
  window: {
    send: (event: HostEvent) => {
      if (win && !win.isDestroyed()) win.webContents.send('agent:event', event)
    },
    broadcastLanguage: (state) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('language:changed', state) },
    inFront: windowInFront,
    setPending: (count) => {
      pendingFollowups = count
      tray?.setPending(count)
    },
    refreshNative: () => tray?.setPending(pendingFollowups),
  },
  loginItem: { set: (on) => app.setLoginItemSettings({ openAtLogin: on, ...(process.platform === 'win32' ? { args: ['--hidden'] } : {}) }) },
  shellSettings: () => ({ shortcut: shortcutHeld === null ? null : { keys: ASK_SHORTCUT, held: shortcutHeld }, openAtLogin: { available: true } }),
}

const backend = createBackend({ host, ipc: ipcMain })

/** The shortcut that opens the island's input, from any app; not in smoke runs, which share the machine. */
function registerShortcut() {
  if (automationMode) return
  shortcutHeld = registerAskShortcut(globalShortcut, {
    foreground: windowInFront,
    focusComposer: () => mainWindow().webContents.send('composer:focus'),
    openInput: () => desk?.openInput() ?? false,
    showWindow,
  })
}

/** Closing the window keeps Viva running in the tray, with the island on the desktop. */
function closeToTray() {
  // A full-screen window hidden as it is would leave its Space behind, black (full-screen.ts).
  const shown = mainWindow()
  if (shown.isFullScreen()) leaveFullScreen(shown, hideToTray)
  else hideToTray()
}

function hideToTray() {
  mainWindow().hide()
  showTray()
  desk?.setAway(true)
}

function showTray() {
  tray ??= createTray({
    Tray, Menu, nativeImage,
    iconDir: path.join(CODE_ROOT, 'src', 'assets', 'tray'),
    platform: process.platform,
    onOpen: showWindow,
    onQuit: () => app.quit(),
    onPending: openTasksPage,
    pending: pendingFollowups,
  })
}

/**
 * The desktop island comes out when the window is closed to the tray and goes when it is shown again; a smoke
 * run turns it on only when it checks it. Closing still follows the normal tray lifecycle.
 */
function attachDeskIsland(window: BrowserWindow) {
  deskAllowed = !automationMode
  const preferences = backend.preferences()
  desk = createDeskIsland({
    BrowserWindow,
    screen,
    preload: path.join(CODE_ROOT, 'src', 'preload', 'desk-preload.cjs'),
    page: path.join(CODE_ROOT, 'src', 'renderer', 'desk.html'),
    mainWindow: window,
    enabled: deskAllowed && preferences.get().deskIsland,
    places: { get: () => preferences.get().deskPlaces, set: (places) => preferences.set('deskPlaces', places) },
    coach: { get: () => preferences.get().deskCoached, set: () => preferences.set('deskCoached', true) },
  })
  window.on('close', (event) => {
    if (backend.isQuitting()) return
    event.preventDefault()
    closeToTray()
  })
  window.on('show', () => desk?.setAway(false))
  // Windows logging off or shutting down closes the window for real, or it would hold the session up.
  window.on('session-end', () => backend.markQuitting())
  window.on('closed', () => {
    desk?.destroy()
    desk = null
  })
}

/** The desktop island's switch, from settings or from 关闭桌面岛 in the island's menu. */
function setDeskIsland(on: boolean) {
  backend.preferences().set('deskIsland', on)
  desk?.setEnabled(on && deskAllowed)
}

/** The shell's settings: the desktop island; the backend answers with the settings as they are now. */
function registerShellSettingsIpc() {
  ipcMain.handle('settings:set-desk-island', (_event, on) => {
    if (typeof on !== 'boolean') throw new Error('invalid desk island switch')
    setDeskIsland(on)
    return backend.settingsView()
  })
  ipcMain.handle('settings:reset-desk-place', () => {
    desk?.resetPlace()
    if (!desk) backend.preferences().set('deskPlaces', { last: null, places: {} })
    return backend.settingsView()
  })
}

/** Run from the repository, the app shows its own icon instead of Electron's. */
function useDevIcon() {
  const icon = devIcon({ platform: process.platform, packaged: app.isPackaged, appRoot: APP_ROOT })
  if (!icon || !fs.existsSync(icon)) return null
  if (process.platform === 'darwin') app.dock?.setIcon(icon)
  return process.platform === 'darwin' ? null : icon
}

function createWindow() {
  const icon = useDevIcon()
  const created = new BrowserWindow({
    ...windowSize(screen.getPrimaryDisplay().workAreaSize),
    ...windowChrome(process.platform),
    ...(icon ? { icon } : {}),
    show: false,
    backgroundColor: '#060B16',
    webPreferences: {
      preload: path.join(CODE_ROOT, 'src', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A smoke run goes on unwatched in the background, where the page and timers would be slowed down.
      backgroundThrottling: !automationMode,
    },
  })
  win = created
  attachDeskIsland(created)
  created.once('ready-to-show', () => {
    if (!startedHidden || automationMode) return created.show()
    // Started with the computer: in the tray, the island on the desktop, until the user opens it.
    showTray()
    desk?.setAway(true)
  })
  // Coming back to the window is one of the user's gaps.
  created.on('focus', () => backend.signal({ kind: 'window.foreground' }))
  // The page never leaves index.html and never opens windows: links go to the browser (shell:open-link).
  created.webContents.on('will-navigate', (event) => event.preventDefault())
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  created.webContents.once('did-finish-load', () => { backend.startBridge() })
  created.loadFile(path.join(CODE_ROOT, 'src', 'renderer', 'index.html'))
}

// Windows shows a notification only for the app its Start menu shortcut names (the installer's, electron-builder appId).
if (process.platform === 'win32') app.setAppUserModelId('app.viva.desktop')
// Before the app is ready: the pages load pasted pictures by name from viva-image:// (image-protocol.ts).
protocol.registerSchemesAsPrivileged([IMAGE_SCHEME_PRIVILEGES])
// dsh's home is the app's own now, so a second copy of the app would share it: hand over to the first.
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => showWindow())
// macOS: clicking the Dock icon brings back a window closed to the tray.
app.on('activate', () => showWindow())

app.whenReady().then(async () => {
  // macOS needs its app menu for ⌘C / ⌘V; elsewhere the hidden title bar has no room for a menu bar.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  backend.open()
  registerImageProtocol(protocol, backend.images())
  registerShellSettingsIpc()
  registerIslandIpc(ipcMain, { desk: () => desk, window: () => win, showWindow, Menu, switchOff: () => setDeskIsland(false) })
  installAutomationDriver(automationMode, { agentPid: backend.agentPid, desk: () => desk, followups: backend.followups })
  // The computer back from sleep, or unlocked: reminders missed meanwhile go out, merged into one.
  const woke = () => backend.signal({ kind: 'system.woke' })
  powerMonitor.on('resume', woke)
  powerMonitor.on('unlock-screen', woke)
  createWindow()
  registerShortcut()
}).catch((err) => {
  // Without a window there is nothing to show the error in, and the process would stay on with nothing to see.
  console.error('[viva] could not start:', err)
  dialog.showErrorBox(t("main.main.viva.could.not.start"), err?.message ?? String(err))
  app.exit(1)
})

app.on('window-all-closed', () => app.quit())
/** Quitting waits for dsh to finish (it may still be writing the session), a few seconds at most. */
app.on('before-quit', (event) => {
  if (backend.isQuitting() || !backend.hasBridge()) {
    backend.markQuitting()
    return
  }
  event.preventDefault()
  backend.markQuitting()
  backend.stop().finally(() => app.quit())
})
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  tray?.destroy()
  backend.close()
})
