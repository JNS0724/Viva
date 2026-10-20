/**
 * The Viva island on the desktop: a small transparent window at the top centre of the screen, shown while
 * the app's window is in the background and the agent works, waits on the user, has just finished or
 * failed. It shows what the window's island shows (island-view.js, sent over IPC) and lets the user allow,
 * reject, answer or stop from there. It never takes the keyboard focus, stays out of screen recordings and
 * lets clicks through except over the island itself.
 */
export const DESK_SIZE = Object.freeze({ width: 440, height: 300 })
const TOP_GAP = 6
/** After a turn: how long the island says done, then how long the cat rests before it goes. */
export const DESK_TIMES = Object.freeze({ done: 5_000, mini: 8_000 })
const SHOWN = new Set(['working', 'waiting', 'asking', 'error'])

/**
 * @param {{ enabled: boolean, foreground: boolean, view: object | null, sinceDone: number }} input
 * @returns {string | null} the form to show, or null to hide
 */
export function deskForm({ enabled, foreground, view, sinceDone }) {
  if (!enabled || foreground || !view) return null
  if (SHOWN.has(view.form)) return view.form
  if (view.form !== 'done') return null
  if (sinceDone < DESK_TIMES.done) return 'done'
  return sinceDone < DESK_TIMES.done + DESK_TIMES.mini ? 'mini' : null
}

/** @param {{ x: number, y: number, width: number }} workArea of the screen the app's window is on */
export function deskBounds(workArea) {
  return { x: Math.round(workArea.x + (workArea.width - DESK_SIZE.width) / 2), y: workArea.y + TOP_GAP, ...DESK_SIZE }
}

const untilNextForm = (sinceDone) => (sinceDone < DESK_TIMES.done ? DESK_TIMES.done : DESK_TIMES.done + DESK_TIMES.mini) - sinceDone

function openWindow({ BrowserWindow, preload, page }) {
  const win = new BrowserWindow({
    ...DESK_SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  })
  win.setAlwaysOnTop(true, 'floating')
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
  win.setContentProtection(true)
  win.setIgnoreMouseEvents(true, { forward: true })
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.loadFile(page)
  return win
}

/**
 * @param {{ BrowserWindow: Function, screen: object, preload: string, page: string, mainWindow: object, enabled: boolean }} deps
 */
export function createDeskIsland({ BrowserWindow, screen, preload, page, mainWindow, enabled }) {
  let win = null
  let view = null
  let doneAt = 0
  let foreground = true
  let forced = false
  let form = null
  let timer = null
  /** Messages sent before the page has loaded would be lost; it gets the latest once it has. */
  let loaded = false

  const alive = () => win && !win.isDestroyed()

  function send() {
    if (alive() && loaded && form) win.webContents.send('island:view', { view, form })
  }

  function show() {
    if (!alive()) {
      loaded = false
      win = openWindow({ BrowserWindow, preload, page })
      win.webContents.on('did-finish-load', () => {
        loaded = true
        send()
      })
    }
    if (win.isVisible()) return
    win.setBounds(deskBounds(screen.getDisplayMatching(mainWindow.getBounds()).workArea))
    win.showInactive()
  }

  function refresh() {
    clearTimeout(timer)
    const sinceDone = Date.now() - doneAt
    form = deskForm({ enabled: enabled || forced, foreground: foreground && !forced, view, sinceDone })
    if (!form) {
      if (alive() && win.isVisible()) win.hide()
      return
    }
    show()
    send()
    if (view.form === 'done') timer = setTimeout(refresh, untilNextForm(sinceDone))
  }

  return {
    /** The window's island changed. */
    setView(next) {
      if (next.form === 'done' && view?.form !== 'done') doneAt = Date.now()
      view = next
      refresh()
    },
    /** Whether the app's window is in front, where it shows its own island. */
    setForeground(value) {
      foreground = value
      refresh()
    },
    /** Clicks reach the island only while the pointer is over it; elsewhere they go to what is below. */
    setPointerInside(inside) {
      if (alive()) win.setIgnoreMouseEvents(!inside, { forward: true })
    },
    /** For the smoke run, whose window is never in front: show the island as if it were away. */
    force(on) {
      forced = on
      refresh()
    },
    owns: (sender) => Boolean(alive() && sender === win.webContents),
    webContents: () => (alive() ? win.webContents : null),
    destroy() {
      clearTimeout(timer)
      if (alive()) win.destroy()
      win = null
    },
  }
}
