import { DESK_SIZE, deskLayout, dragBounds, keepInside, pointOf, readPlaces, settle, withPlace } from './desk-place.js'

/**
 * The Viva island on the desktop: a small transparent window, at the top centre of the screen unless the
 * user dragged it elsewhere (desk-place.js). It is shown once the app's window was closed to the tray: as
 * the agent works, waits on the user, has just finished or failed, and otherwise as just the cat, which
 * the user may click, drop files on or call up with the shortcut to ask something. It shows what the window's island shows (island-view.js, sent over IPC) and
 * lets the user allow, reject, answer, stop or ask from there. It takes the keyboard only while its input
 * is open, stays out of screen recordings and lets clicks through except over the island itself.
 */
export { DESK_SIZE }
/**
 * After a turn: how long the island says done, then how long the cat rests before it goes. Done waits while
 * the pointer rests on it, and stays this long (linger) once the pointer leaves.
 */
export const DESK_TIMES = Object.freeze({ done: 5_000, mini: 8_000, linger: 2_000 })
const SHOWN = new Set(['working', 'waiting', 'asking', 'error'])
/**
 * How often the pointer is checked against the island. While it is dragged the island moves at the page's
 * frames instead (desk.js), so in step with the screen and only when the pointer moved.
 */
const POINTER_MS = 50
/** The island takes the pointer this far beyond its edge. */
const POINTER_SLOP = 4

/**
 * @param {{
 *   enabled: boolean, away: boolean, view: object | null, sinceDone: number, input?: boolean, summoned?: boolean,
 * }} input away: the window was closed to the tray; summoned: called up with the shortcut while switched off
 * @returns {string | null} the form to show, or null to hide
 */
export function deskForm({ enabled, away, view, sinceDone, input = false, summoned = false }) {
  if (!away) return null
  if (input) return 'input'
  if (!enabled && !summoned) return null
  if (view && SHOWN.has(view.form)) return view.form
  if (view?.form === 'done' && sinceDone < DESK_TIMES.done) return 'done'
  // With the window in the tray the cat stays on the desktop; called up while switched off, it goes in a while.
  if (enabled) return 'mini'
  return view?.form === 'done' && sinceDone < DESK_TIMES.done + DESK_TIMES.mini ? 'mini' : null
}

const untilNextForm = (sinceDone) => (sinceDone < DESK_TIMES.done ? DESK_TIMES.done : DESK_TIMES.done + DESK_TIMES.mini) - sinceDone

/** Without a store of its own, the first-time note counts as seen. */
const SEEN = Object.freeze({ get: () => true, set: () => {} })

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
  // Without `forward`: on Windows it hooks every mouse move on the system (WH_MOUSE_LL) through this process.
  // Where the pointer is comes from checkPointer instead.
  win.setIgnoreMouseEvents(true)
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.loadFile(page)
  return win
}

/**
 * @param {{
 *   BrowserWindow: Function, screen: object, preload: string, page: string, mainWindow: object, enabled: boolean,
 *   places: { get: () => object, set: (places: object) => void }, coach?: { get: () => boolean, set: () => void },
 * }} deps places: where the island was dragged to (preferences.json deskPlaces); coach: whether the user has
 *   seen what the island can do (preferences.json deskCoached)
 */
export function createDeskIsland({ BrowserWindow, screen, preload, page, mainWindow, enabled: initiallyEnabled, places: placeStore, coach = SEEN }) {
  let enabled = initiallyEnabled
  let coached = coach.get()
  /** The pointer is over the island. */
  let hovering = false
  /** Hidden from its menu: switched off until the window is next closed to the tray. */
  let hidden = false
  let win = null
  let view = null
  let doneAt = 0
  /** The window was closed to the tray. */
  let away = false
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
    win.webContents.send('island:view', {
      view, form, align: layout?.align ?? 'center', dir: layout?.dir ?? 'down', dragging: Boolean(drag), coach: !coached, hover: hovering,
    })
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
    win.setIgnoreMouseEvents(value)
  }

  /**
   * Clicks and dropped files reach the island only while the pointer is over it. The pointer is checked from
   * here rather than from the page, which hears nothing while it lets the pointer through; the page hears
   * from here whether the pointer rests on the island (`hover`).
   */
  function checkPointer() {
    if (!alive() || !win.isVisible()) return
    if (drag) return setIgnoring(false)
    if (!islandRect) return setIgnoring(true)
    const bounds = win.getBounds()
    const cursor = screen.getCursorScreenPoint()
    const inside = within({ x: cursor.x - bounds.x, y: cursor.y - bounds.y }, islandRect)
    setIgnoring(!inside)
    return setHovering(inside)
  }

  /** The page shows the island's tools under a resting pointer; done waits while the pointer rests on it. */
  function setHovering(value) {
    if (value === hovering) return
    hovering = value
    if (form !== 'done') return send()
    if (!value) doneAt = Math.max(doneAt, Date.now() - DESK_TIMES.done + DESK_TIMES.linger)
    refresh()
  }

  function markCoached() {
    if (coached) return
    coached = true
    coach.set()
    send()
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
    const held = hovering && form === 'done'
    const sinceDone = held ? 0 : Date.now() - doneAt
    form = deskForm({ enabled: (enabled && !hidden) || forced, away: away || forced, view, sinceDone, input, summoned })
    if (!form) {
      summoned = false
      hide()
      return
    }
    show()
    send()
    if (view?.form === 'done' && !input && !held && sinceDone < DESK_TIMES.done + DESK_TIMES.mini) timer = setTimeout(refresh, untilNextForm(sinceDone))
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

  /**
   * One step of a drag, at a frame of the page: the window follows the pointer, if it moved. Its size is given
   * at every step, not just its position: on Windows at a fractional scale (175%) `setPosition` rounds the
   * size it keeps, and the window grows a little at every move.
   */
  function dragMove() {
    if (!alive() || !drag) return
    const cursor = screen.getCursorScreenPoint()
    if (drag.cursor?.x === cursor.x && drag.cursor?.y === cursor.y) return
    const display = screen.getDisplayNearestPoint(cursor)
    const point = keepInside(cursor, display.workArea)
    win.setBounds(dragBounds(point))
    drag = { cursor, display, point }
  }

  return {
    /** The window's island changed. */
    setView(next) {
      if (next.form === 'done' && view?.form !== 'done') doneAt = Date.now()
      view = next
      refresh()
    },
    /** Whether the app's window was closed to the tray; shown again, it has its own island and input. */
    setAway(value) {
      away = value
      if (value) hidden = false
      if (!value) closeInput()
      refresh()
    },
    /** Where the island is inside its window (the page reports it whenever its shape changes). */
    setIslandRect(rect) {
      islandRect = rect
      checkPointer()
    },
    /** The shortcut, or files dropped on the island: open the input and take the keyboard. */
    openInput() {
      if (!away && !forced) return false
      input = true
      summoned = summoned || !enabled
      markCoached()
      refresh()
      takeKeyboard()
      return true
    },
    closeInput,
    inputOpen: () => input,
    /** The user holds the island and moves it: it shrinks to the cat and follows the pointer until let go. */
    startDrag() {
      if (drag || !alive()) return
      markCoached()
      drag = { cursor: null, display: currentDisplay(), point: null }
      send()
      dragMove()
    },
    dragMove,
    endDrag() {
      if (!drag) return
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
    /** The user has seen what the island can do: the first-time note goes for good. */
    markCoached,
    /** The right-click menu, over the island. */
    popup(menu) {
      if (alive() && win.isVisible()) menu.popup({ window: win })
    },
    working: () => view?.form === 'working',
    /** 先隐藏 in its menu: gone until the window is next closed to the tray; the shortcut still calls it up. */
    hideUntilAway() {
      hidden = true
      refresh()
    },
    /** The user's switch in settings, or 不再显示桌面岛 in its menu. */
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
      drag = null
      if (alive()) win.destroy()
      win = null
    },
  }
}
