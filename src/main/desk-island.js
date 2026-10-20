import { DESK_SIZE, deskLayout, keepInside, pointOf, readPlaces, settle, withPlace } from './desk-place.js'

/**
 * The Viva island on the desktop: a small transparent window, at the top centre of the screen unless the
 * user dragged it elsewhere (desk-place.js). It is shown while the app's window is in the background and
 * the agent works, waits on the user, has just finished or failed, and when the user calls it up with the
 * shortcut to ask something. It shows what the window's island shows (island-view.js, sent over IPC) and
 * lets the user allow, reject, answer, stop or ask from there. It takes the keyboard only while its input
 * is open, stays out of screen recordings and lets clicks through except over the island itself.
 */
export { DESK_SIZE }
/** After a turn: how long the island says done, then how long the cat rests before it goes. */
export const DESK_TIMES = Object.freeze({ done: 5_000, mini: 8_000 })
const SHOWN = new Set(['working', 'waiting', 'asking', 'error'])
/** How often the pointer is checked against the island, and the island moved while dragged. */
const POINTER_MS = 50
const DRAG_MS = 16
/** The island takes the pointer this far beyond its edge. */
const POINTER_SLOP = 4

/**
 * @param {{ enabled: boolean, foreground: boolean, view: object | null, sinceDone: number, input?: boolean }} input
 * @returns {string | null} the form to show, or null to hide
 */
export function deskForm({ enabled, foreground, view, sinceDone, input = false }) {
  if (input && !foreground) return 'input'
  if (!enabled || foreground || !view) return null
  if (SHOWN.has(view.form)) return view.form
  if (view.form !== 'done') return null
  if (sinceDone < DESK_TIMES.done) return 'done'
  return sinceDone < DESK_TIMES.done + DESK_TIMES.mini ? 'mini' : null
}

const untilNextForm = (sinceDone) => (sinceDone < DESK_TIMES.done ? DESK_TIMES.done : DESK_TIMES.done + DESK_TIMES.mini) - sinceDone

/** @param {{ x: number, y: number }} point @param {{ x: number, y: number, width: number, height: number }} rect */
const within = (point, rect) => point.x >= rect.x - POINTER_SLOP && point.x <= rect.x + rect.width + POINTER_SLOP
  && point.y >= rect.y - POINTER_SLOP && point.y <= rect.y + rect.height + POINTER_SLOP

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
    // macOS: a non-activating panel takes the keyboard for the input without bringing the app forward,
    // so the app the user was in stays in front and gets the keyboard back when the input closes.
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
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
 * @param {{
 *   BrowserWindow: Function, screen: object, preload: string, page: string, mainWindow: object, enabled: boolean,
 *   places: { get: () => object, set: (places: object) => void },
 * }} deps places: where the island was dragged to (preferences.json deskPlaces)
 */
export function createDeskIsland({ BrowserWindow, screen, preload, page, mainWindow, enabled: initiallyEnabled, places: placeStore }) {
  let enabled = initiallyEnabled
  let win = null
  let view = null
  let doneAt = 0
  let foreground = true
  let forced = false
  let form = null
  let timer = null
  /** Messages sent before the page has loaded would be lost; it gets the latest once it has. */
  let loaded = false
  /** The input is open (the shortcut, or files dropped on the island). */
  let input = false
  /** Called up while the island is switched off: it stays until what was asked is done. */
  let summoned = false
  let places = readPlaces(placeStore.get())
  let layout = null
  /** The island inside its window, as the page last reported it. */
  let islandRect = null
  let ignoring = true
  let pointerTimer = null
  /** While the island is dragged: the timer moving it, and the display and point it is over. */
  let drag = null

  const alive = () => win && !win.isDestroyed()

  function send() {
    if (!alive() || !loaded || !form) return
    win.webContents.send('island:view', { view, form, align: layout?.align ?? 'center', dir: layout?.dir ?? 'down', dragging: Boolean(drag) })
  }

  /** The display the island was last dragged to, while it is connected; else the one the app's window is on. */
  function currentDisplay() {
    const last = places.last && screen.getAllDisplays().find((display) => String(display.id) === places.last)
    return last || screen.getDisplayMatching(mainWindow.getBounds())
  }

  function place() {
    const display = currentDisplay()
    layout = deskLayout(pointOf(places.places[String(display.id)], display.workArea), display.workArea)
    win.setBounds(layout.bounds)
  }

  function setIgnoring(value) {
    if (value === ignoring || !alive()) return
    ignoring = value
    win.setIgnoreMouseEvents(value, { forward: true })
  }

  /**
   * Clicks and dropped files reach the island only while the pointer is over it. The pointer is checked from
   * here rather than from the page, which hears nothing while it lets the pointer through, as during a drag.
   */
  function checkPointer() {
    if (!alive() || !win.isVisible()) return
    if (drag) return setIgnoring(false)
    if (!islandRect) return setIgnoring(true)
    const bounds = win.getBounds()
    const cursor = screen.getCursorScreenPoint()
    return setIgnoring(!within({ x: cursor.x - bounds.x, y: cursor.y - bounds.y }, islandRect))
  }

  function show() {
    if (!alive()) {
      loaded = false
      ignoring = true
      win = openWindow({ BrowserWindow, preload, page })
      win.webContents.on('did-finish-load', () => {
        loaded = true
        send()
        if (input) takeKeyboard()
      })
      win.on('blur', () => input && closeInput())
    }
    if (win.isVisible()) return
    place()
    win.showInactive()
    clearInterval(pointerTimer)
    pointerTimer = setInterval(checkPointer, POINTER_MS)
  }

  function hide() {
    clearInterval(pointerTimer)
    if (alive() && win.isVisible()) win.hide()
  }

  function refresh() {
    clearTimeout(timer)
    const sinceDone = Date.now() - doneAt
    form = deskForm({ enabled: enabled || forced || summoned, foreground: foreground && !forced, view, sinceDone, input })
    if (!form) {
      summoned = false
      hide()
      return
    }
    show()
    send()
    if (view?.form === 'done' && !input) timer = setTimeout(refresh, untilNextForm(sinceDone))
  }

  /** A window focused before its page has loaded loses the focus again as it loads; so only once it has. */
  function takeKeyboard() {
    if (!alive() || !loaded) return
    win.setFocusable(true)
    win.focus()
  }

  /** @param {{ sent?: boolean }} [options] sent: what was asked keeps the island up until it is done */
  function closeInput({ sent = false } = {}) {
    if (!input) return
    input = false
    summoned = summoned && sent
    if (alive()) {
      if (win.isFocused()) win.blur()
      win.setFocusable(false)
    }
    refresh()
  }

  function moveWithPointer() {
    if (!alive() || !drag) return
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const point = keepInside(cursor, display.workArea)
    const next = deskLayout(point, display.workArea, { dragging: true })
    win.setBounds(next.bounds)
    const turned = next.dir !== layout?.dir || next.align !== layout?.align
    layout = next
    drag = { ...drag, display, point }
    if (turned) send()
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
      if (value) closeInput()
      refresh()
    },
    /** Where the island is inside its window (the page reports it whenever its shape changes). */
    setIslandRect(rect) {
      islandRect = rect
      checkPointer()
    },
    /** The shortcut, or files dropped on the island: open the input and take the keyboard. */
    openInput() {
      if (foreground && !forced) return false
      input = true
      summoned = summoned || !enabled
      refresh()
      takeKeyboard()
      return true
    },
    closeInput,
    inputOpen: () => input,
    /** The user holds the island and moves it: it follows the pointer until let go. */
    startDrag() {
      if (drag || !alive()) return
      drag = { display: currentDisplay(), point: null, timer: setInterval(moveWithPointer, DRAG_MS) }
      send()
    },
    endDrag() {
      if (!drag) return
      clearInterval(drag.timer)
      const { display, point } = drag
      drag = null
      if (point) {
        places = withPlace(places, display.id, settle(point, display.workArea))
        placeStore.set(places)
      }
      if (alive()) place()
      send()
    },
    /** Settings: back to the top centre, on every display. */
    resetPlace() {
      places = readPlaces(null)
      placeStore.set(places)
      if (alive() && win.isVisible()) {
        place()
        send()
      }
    },
    /** The user's switch in settings. */
    setEnabled(value) {
      enabled = value
      refresh()
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
      clearInterval(pointerTimer)
      if (drag) clearInterval(drag.timer)
      drag = null
      if (alive()) win.destroy()
      win = null
    },
  }
}
