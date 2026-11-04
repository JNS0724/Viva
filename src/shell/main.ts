import { t } from '../shared/i18n/translate.ts'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, BrowserWindow, dialog, globalShortcut, ipcMain as electronIpcMain, Menu, nativeImage, Notification, powerMonitor, protocol, safeStorage, screen, shell, Tray } from 'electron'
import type { FileOptions, FolderOptions, ShellSettings } from '../backend/host.ts'
import type { HostCall, HostMethod, Mirror } from '../backend/wire.ts'
import { setLocale, type LanguageState } from '../shared/i18n/locale.ts'
import { type BackendProcess, spawnBackend } from './backend-client.ts'
import { createBackendKeeper } from './backend-keeper.ts'
import { APP_ROOT, CODE_ROOT } from '../shared/node/app-roots.ts'
import { loadDataKey } from './data-key.ts'
import { createDeskIsland } from './desk-island.ts'
import { leaveFullScreen } from './full-screen.ts'
import { IMAGE_SCHEME_PRIVILEGES, registerImageProtocol } from './image-protocol.ts'
import { type Channel, checkedIpc } from '../shared/ipc-contract.ts'
import { ASK_SHORTCUT, registerAskShortcut, registerIslandIpc } from './island-main.ts'
import type { Notice } from '../backend/notice-plan.ts'
import type { Preferences } from '../backend/preferences.ts'
import { createTray } from './tray.ts'
import { installAutomationDriver } from './automation-driver.ts'
import { devIcon, windowChrome, windowSize } from './window-options.ts'

/**
 * The desktop shell (docs/system-design.md §2): the app's lifecycle, the window, the tray, the
 * desktop island, the shortcut, notifications, dialogs and the system shell. Everything else is the backend's, in
 * its own process (src/backend/server.ts): the shell starts it, forwards the pages' calls to it, does what it asks
 * of the desktop, and keeps it told what it reads without waiting (the mirror). A backend that ends on its own is
 * started again (backend-keeper.ts), and the window reloads onto it.
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
/** How often the backend is told how long the user has been away (follow-ups' gaps poll it each minute). */
const IDLE_MIRROR_MS = 15_000
/** How soon the shell listens again when the backend's stream ends while the backend runs. */
const RELISTEN_MS = 1_000
/** The backend process (src/backend/server.ts), built to out/ beside this file. */
const BACKEND_ENTRY = path.join(CODE_ROOT, 'src', 'backend', 'server.js')
/** Started with the computer (开机启动): the window stays hidden, Viva in the tray. */
const startedHidden = process.argv.includes('--hidden') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin)

type ShellPreferences = Pick<Preferences, 'deskIsland' | 'deskPlaces' | 'deskCoached'>

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
/** The desktop island's preferences, kept here as the island reads them at once; written through to the backend. */
let shellPreferences: ShellPreferences = { deskIsland: true, deskPlaces: { last: null, places: {} }, deskCoached: false }
/** Quitting has begun (or the session ends): the window closes for real, and the backend's end is expected. */
let quitting = false
/** The backend is stopping dsh and closing; then quitting goes on. */
let backendClosing: Promise<void> | null = null
let backendClosed = false
let lastInFront = false

/** The backend's connection once it is running: at once, or after a restart (backend-keeper.ts). */
const backendConnection = async () => (await keeper.get()).connection

/** A call the shell makes of the backend and does not wait for; a failure is only logged. */
function tellBackend(op: string, ...args: unknown[]) {
  keeper.running()?.connection.control(op, ...args).catch((err: Error) => console.error(`[backend] ${op}:`, err.message))
}

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
const shellSettings = (): ShellSettings => ({ shortcut: shortcutHeld === null ? null : { keys: ASK_SHORTCUT, held: shortcutHeld }, openAtLogin: { available: true } })

/** The backend reads these without asking (remote-host.ts); they are sent when they change. */
function mirror(update: Partial<Mirror>) {
  tellBackend('mirror', update)
}

function mirrorInFront() {
  const now = windowInFront()
  if (now === lastInFront) return
  lastInFront = now
  mirror({ inFront: now })
}

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

/** The language changed in the backend: the shell's own words (the tray, dialogs) and every window follow. */
function followLanguage(state: LanguageState) {
  setLocale(state.locale)
  tray?.setPending(pendingFollowups)
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('language:changed', state)
}

/** What the backend may ask of this desktop (remote-host.ts): one handler for each of its calls. */
const HOST: { readonly [M in HostMethod]: (...args: any[]) => unknown } = {
  'window.send': (event: unknown) => {
    if (win && !win.isDestroyed()) win.webContents.send('agent:event', event)
  },
  'window.broadcastLanguage': (state: LanguageState) => followLanguage(state),
  'window.setPending': (count: number) => {
    pendingFollowups = count
    tray?.setPending(count)
  },
  'window.refreshNative': () => tray?.setPending(pendingFollowups),
  'dialogs.chooseFolder': ({ title, createDirectory = false, defaultPath, showHidden = false }: FolderOptions) => folderOf({
    title, ...(defaultPath ? { defaultPath } : {}),
    properties: ['openDirectory', ...(createDirectory ? ['createDirectory' as const] : []), ...(showHidden ? ['showHiddenFiles' as const] : [])],
  }),
  'dialogs.chooseFiles': async ({ title, multiple = false }: FileOptions) => {
    const result = await dialog.showOpenDialog(mainWindow(), { title, properties: ['openFile', ...(multiple ? ['multiSelections' as const] : [])] })
    return result.canceled ? null : result.filePaths
  },
  'shell.openExternal': (url: string) => shell.openExternal(url),
  'shell.openPath': (dir: string) => shell.openPath(dir),
  'shell.showItemInFolder': (file: string) => shell.showItemInFolder(file),
  'shell.trash': (file: string) => shell.trashItem(file),
  notify: (notice: Notice, callbackId: number) => showNotice(notice, (afterMs) => {
    // A backend started again since knows nothing of this id: the click is then only logged.
    keeper.running()?.connection.callback(callbackId, [afterMs]).catch((err: Error) => console.error('[backend] notice opened:', err.message))
  }),
  'loginItem.set': (on: boolean) => app.setLoginItemSettings({ openAtLogin: on, ...(process.platform === 'win32' ? { args: ['--hidden'] } : {}) }),
}

function runHostCall(call: HostCall): unknown {
  const handler = Object.hasOwn(HOST, call.method) ? HOST[call.method] : undefined
  if (!handler) throw new Error(`no host call ${String(call.method)}`)
  return handler(...call.args)
}

/** The backend kept crashing: without it there is nothing the window can do. */
function backendGaveUp(why: string) {
  if (quitting) return
  console.error(`[viva] the backend ended: ${why}`)
  dialog.showErrorBox(t("main.main.backend.stopped"), why)
  app.exit(1)
}

/** A backend, started with what it reads of the desktop and the keys' data key. */
function startBackend(onExit: (code: number | null, signal: NodeJS.Signals | null) => void): Promise<BackendProcess> {
  const userData = app.getPath('userData')
  const dataKey = loadDataKey({ dir: userData, keychain: safeStorage, onProblem: (message) => console.error('[secrets]', message) })
  return spawnBackend({
    entry: BACKEND_ENTRY,
    onExit,
    start: {
      type: 'start',
      token: randomBytes(32).toString('hex'),
      dataKey: dataKey?.toString('base64') ?? null,
      paths: { userData, home: os.homedir() },
      packaged: app.isPackaged,
      automation: automationMode,
      locale: app.getLocale(),
      mirror: { inFront: windowInFront(), idleSeconds: powerMonitor.getSystemIdleTime(), shellSettings: shellSettings() },
    },
  })
}

/**
 * Does what `started` asks of the desktop. A stream that ends while the backend runs is listened to again, from
 * the last push's number, so what the backend stored meanwhile comes first.
 */
function listenTo(started: BackendProcess, since?: number) {
  let last = since
  const host = (call: HostCall) => {
    const push = call.method === 'window.send' ? call.args[0] as { seq?: unknown } | undefined : undefined
    if (typeof push?.seq === 'number') last = Math.max(last ?? 0, push.seq)
    return runHostCall(call)
  }
  started.connection.listen({
    since,
    host,
    stored: (event) => { last = Math.max(last ?? 0, event.seq) },
    ended: (err) => {
      if (quitting || keeper.running() !== started) return
      console.error('[backend] its events ended; listening again:', err?.message ?? '')
      setTimeout(() => { if (!quitting && keeper.running() === started) listenTo(started, last ?? 0) }, RELISTEN_MS)
    },
  })
}

/** A backend is up. After a restart the window reloads onto it, and dsh starts again once the page has loaded. */
function backendUp(started: BackendProcess, restarted: boolean) {
  setLocale(started.ready.locale)
  listenTo(started)
  if (!restarted) return
  mirror({ shellSettings: shellSettings() })
  const shown = win && !win.isDestroyed() ? win : null
  if (!shown) return
  shown.webContents.once('did-finish-load', () => tellBackend('start-bridge'))
  shown.webContents.reload()
}

const keeper = createBackendKeeper<BackendProcess>({ spawn: startBackend, onUp: backendUp, onGaveUp: backendGaveUp })

/** The pages' calls on the backend's channels go to it, after the same check as the shell's own (ipc-contract.ts). */
function forwardChannels(started: BackendProcess) {
  for (const { channel, kind } of started.ready.channels) {
    const name = channel as Channel
    if (kind === 'handle') ipcMain.handle(name, async (_event, ...args: unknown[]) => (await backendConnection()).rpc(channel, args))
    else ipcMain.on(name, (_event, ...args: unknown[]) => { backendConnection().then((connection) => connection.rpc(channel, args)).catch((err: Error) => console.error(`[ipc] ${channel}:`, err.message)) })
  }
}

/** One of the desktop island's preferences: here at once, in the backend's file once it answers. */
async function setShellPreference<K extends keyof ShellPreferences>(key: K, value: ShellPreferences[K]): Promise<unknown> {
  shellPreferences = { ...shellPreferences, [key]: value }
  return (await backendConnection()).control('preferences-set', key, value)
}

const logged = (what: string) => (err: Error) => console.error(`[desk] ${what}:`, err.message)

/** The shortcut that opens the island's input, from any app; not in smoke runs, which share the machine. */
function registerShortcut() {
  if (automationMode) return
  shortcutHeld = registerAskShortcut(globalShortcut, {
    foreground: windowInFront,
    focusComposer: () => mainWindow().webContents.send('composer:focus'),
    openInput: () => desk?.openInput() ?? false,
    showWindow,
  })
  mirror({ shellSettings: shellSettings() })
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
  desk = createDeskIsland({
    BrowserWindow,
    screen,
    preload: path.join(CODE_ROOT, 'src', 'preload', 'desk-preload.cjs'),
    page: path.join(CODE_ROOT, 'src', 'renderer', 'desk.html'),
    mainWindow: window,
    enabled: deskAllowed && shellPreferences.deskIsland,
    places: { get: () => shellPreferences.deskPlaces, set: (places) => { setShellPreference('deskPlaces', places).catch(logged('places')) } },
    coach: { get: () => shellPreferences.deskCoached, set: () => { setShellPreference('deskCoached', true).catch(logged('coached')) } },
  })
  window.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    closeToTray()
  })
  window.on('show', () => desk?.setAway(false))
  // Whether the window is in front, which the backend reads without asking (follow-ups hold notices then).
  window.on('focus', mirrorInFront)
  window.on('blur', mirrorInFront)
  window.on('show', mirrorInFront)
  window.on('hide', mirrorInFront)
  window.on('minimize', mirrorInFront)
  window.on('restore', mirrorInFront)
  // Windows logging off or shutting down closes the window for real, or it would hold the session up.
  window.on('session-end', () => {
    quitting = true
    tellBackend('mark-quitting')
  })
  window.on('closed', () => {
    desk?.destroy()
    desk = null
  })
}

/** The desktop island's switch, from settings or from 关闭桌面岛 in the island's menu. */
function setDeskIsland(on: boolean): Promise<unknown> {
  desk?.setEnabled(on && deskAllowed)
  return setShellPreference('deskIsland', on)
}

/** The shell's settings: the desktop island; the backend answers with the settings as they are now. */
function registerShellSettingsIpc() {
  ipcMain.handle('settings:set-desk-island', async (_event, on) => {
    if (typeof on !== 'boolean') throw new Error('invalid desk island switch')
    await setDeskIsland(on)
    return (await backendConnection()).control('settings-view')
  })
  ipcMain.handle('settings:reset-desk-place', async () => {
    desk?.resetPlace()
    if (!desk) await setShellPreference('deskPlaces', { last: null, places: {} })
    return (await backendConnection()).control('settings-view')
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
  created.on('focus', () => tellBackend('signal', { kind: 'window.foreground' }))
  // The page never leaves index.html and never opens windows: links go to the browser (shell:open-link).
  created.webContents.on('will-navigate', (event) => event.preventDefault())
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  created.webContents.once('did-finish-load', () => tellBackend('start-bridge'))
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
  const started = await keeper.start()
  forwardChannels(started)
  shellPreferences = await started.connection.control<Preferences>('preferences-get')
  registerImageProtocol(protocol, async (url) => (await backendConnection()).image(url))
  registerShellSettingsIpc()
  registerIslandIpc(ipcMain, { desk: () => desk, window: () => win, showWindow, Menu, switchOff: () => { setDeskIsland(false).catch(logged('switch off')) } })
  installAutomationDriver(automationMode, {
    agentPid: async () => (await backendConnection()).control<number | null>('agent-pid'),
    backendPid: () => keeper.running()?.pid ?? null,
    desk: () => desk,
    seedPrepared: async (item) => (await backendConnection()).control<void>('automation.seed-prepared', item),
  })
  // The computer back from sleep, or unlocked: reminders missed meanwhile go out, merged into one.
  const woke = () => tellBackend('signal', { kind: 'system.woke' })
  powerMonitor.on('resume', woke)
  powerMonitor.on('unlock-screen', woke)
  setInterval(() => mirror({ idleSeconds: powerMonitor.getSystemIdleTime() }), IDLE_MIRROR_MS).unref()
  createWindow()
  registerShortcut()
}).catch((err) => {
  // Without a window there is nothing to show the error in, and the process would stay on with nothing to see.
  console.error('[viva] could not start:', err)
  dialog.showErrorBox(t("main.main.viva.could.not.start"), err?.message ?? String(err))
  app.exit(1)
})

app.on('window-all-closed', () => app.quit())
/** Quitting waits for the backend to stop dsh (it may still be writing the session) and close, a few seconds at most. */
app.on('before-quit', (event) => {
  quitting = true
  if (backendClosed) return
  event.preventDefault()
  backendClosing ??= keeper.shutdown().finally(() => {
    backendClosed = true
    app.quit()
  })
})
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  tray?.destroy()
})
