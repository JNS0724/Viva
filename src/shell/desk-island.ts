import type { BrowserWindow as Win, Menu, Screen, WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { DESK_SIZE, DRAG_SIZE, FIXED_DESK_HOST, deskLayout, dragBounds, keepInside, pointOf, readPlaces, settle, withPlace } from './desk-place.ts'

type Point = { x: number, y: number }
type Rect = { x: number, y: number, width: number, height: number }
/** What the window's island shows (renderer/island-view.ts), as checked (island-ipc.ts checkIslandView). */
type DeskView = { form: string, [field: string]: any }

/**
 * The Viva island on the desktop: a small transparent window, at the top centre of the screen unless the
 * user dragged it elsewhere (desk-place.js). It is shown once the app's window was closed to the tray: as
 * the agent works, waits on the user, has just finished or failed, and otherwise as just the cat, which
 * the user may click, drop files on or call up with the shortcut to ask something. It shows what the window's island shows (island-view.js, sent over IPC) and
 * lets the user allow, reject, answer, stop or ask from there. It takes the keyboard only while its input
 * is open and lets clicks through except over the island itself.
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
/** If the renderer is slow, keep the full transparent surface until its compact layout is ready. */
export const LAYOUT_READY_MS = 250
// On Windows the floating level can be demoted during activation. The screen-saver
// level keeps the native topmost band; macOS keeps its non-activating panel level.
const TOP_LEVEL = process.platform === 'win32' ? 'screen-saver' : 'floating'

/**
 * @param input away: the window was closed to the tray; summoned: called up with the shortcut while switched off
 * @returns the form to show, or null to hide
 */
export function deskForm({ enabled, away, view, sinceDone, input = false, summoned = false }: {
  enabled: boolean, away: boolean, view: DeskView | null, sinceDone: number, input?: boolean, summoned?: boolean,
}): string | null {
  if (!away) return null
  if (input) return 'input'
  if (!enabled && !summoned) return null
  if (view && SHOWN.has(view.form)) return view.form
  if (view?.form === 'done' && sinceDone < DESK_TIMES.done) return 'done'
  // With the window in the tray the cat stays on the desktop; called up while switched off, it goes in a while.
  if (enabled) return 'mini'
  return view?.form === 'done' && sinceDone < DESK_TIMES.done + DESK_TIMES.mini ? 'mini' : null
}

const untilNextForm = (sinceDone: number) => (sinceDone < DESK_TIMES.done ? DESK_TIMES.done : DESK_TIMES.done + DESK_TIMES.mini) - sinceDone

/** Without a store of its own, the first-time note counts as seen. */
const SEEN = Object.freeze({ get: () => true, set: () => {} })

const within = (point: Point, rect: Rect) => point.x >= rect.x - POINTER_SLOP && point.x <= rect.x + rect.width + POINTER_SLOP
  && point.y >= rect.y - POINTER_SLOP && point.y <= rect.y + rect.height + POINTER_SLOP

function openWindow({ BrowserWindow, preload, page }: { BrowserWindow: typeof Win, preload: string, page: string }) {
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
    // Windows: keep the native activation style stable. showInactive() avoids stealing focus;
    // toggling focusability on a transparent HWND can lose its topmost and input styles.
    focusable: process.platform === 'win32',
    alwaysOnTop: true,
    // macOS: a non-activating panel takes the keyboard for the input without bringing the app forward,
    // so the app the user was in stays in front and gets the keyboard back when the input closes.
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  })
  win.setAlwaysOnTop(true, TOP_LEVEL)
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
  // Without `forward`: on Windows it hooks every mouse move on the system (WH_MOUSE_LL) through this process.
  // Where the pointer is comes from checkPointer instead.
  win.setIgnoreMouseEvents(true)
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.loadFile(page)
  return win
}

/**
 * deps.places: where the island was dragged to (preferences.json deskPlaces); coach: whether the user has
 * seen what the island can do (preferences.json deskCoached)
 */
export function createDeskIsland({ BrowserWindow, screen, preload, page, mainWindow, enabled: initiallyEnabled, places: placeStore, coach = SEEN as { get: () => boolean, set: () => void }, onOwnership = (_owner: 'main' | 'desk') => {} }: {
  BrowserWindow: typeof Win, screen: Pick<Screen, 'getAllDisplays' | 'getDisplayMatching' | 'getCursorScreenPoint' | 'getDisplayNearestPoint'>,
  preload: string, page: string, mainWindow: Pick<Win, 'getBounds'>, enabled: boolean,
  places: { get: () => unknown, set: (places: ReturnType<typeof readPlaces>) => void }, coach?: { get: () => boolean, set: () => void },
  onOwnership?: (owner: 'main' | 'desk') => void,
}) {
  let enabled = initiallyEnabled
  let coached = coach.get()
  /** The pointer is over the island. */
  let hovering = false
  /** Hidden from its menu: switched off until the window is next closed to the tray. */
  let hidden = false
  let win: Win | null = null
  const retired = new Set<Win>()
  const imports = new Map<string, { sender: WebContents, key: string, window: Win }>()
  let view: DeskView | null = null
  let doneAt = 0
  /** The window was closed to the tray. */
  let away = false
  let forced = false
  let form: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  /** Messages sent before the page has loaded would be lost; it gets the latest once it has. */
  let loaded = false
  /** The input is open (the shortcut, or files dropped on the island). */
  let input = false
  let panel: 'input' | 'request' | 'background' | 'status' = 'input'
  /** Called up while the island is switched off: it stays until what was asked is done. */
  let summoned = false
  let places = readPlaces(placeStore.get())
  let layout: ReturnType<typeof deskLayout> | null = null
  /** The island inside its window, as the page last reported it. */
  let islandRect: Rect | null = null
  let regions: Rect[] = []
  let ignoring = true
  let pointerTimer: ReturnType<typeof setInterval> | undefined
  let styleTimer: ReturnType<typeof setTimeout> | undefined
  /** Pointer position and renderer readiness for the current drag. */
  let drag: { cursor: Point | null, layout: 'fixed' | 'waiting' | 'compact' | 'full', grab: Point, origin: ReturnType<typeof deskLayout>, expanded: boolean } | null = null
  let layoutVersion = 0
  let awaitingLayout = false
  let layoutTimer: ReturnType<typeof setTimeout> | undefined
  let appliedShape: { window: Win, rects: Rect[] } | null = null

  /** The island's window while it is there. */
  const live = (): Win | null => (win && !win.isDestroyed() ? win : null)

  function forgetWindow(opened: Win) {
    for (const [ticket, held] of imports) if (held.window === opened) imports.delete(ticket)
    retired.delete(opened)
    if (win !== opened) return
    appliedShape = null
    clearInterval(pointerTimer)
    clearTimeout(styleTimer)
    clearTimeout(layoutTimer)
    win = null
    loaded = false
  }

  function releaseImport(ticket: string) {
    const held = imports.get(ticket)
    if (!held) return
    imports.delete(ticket)
    if (retired.has(held.window) && ![...imports.values()].some(other => other.window === held.window)) {
      retired.delete(held.window)
      if (!held.window.isDestroyed()) held.window.destroy()
    }
  }

  // Reapply the level if native activation changed the window's topmost state.
  function restoreTopmost() {
    const shown = live()
    if (!shown || shown.isAlwaysOnTop()) return
    shown.setAlwaysOnTop(false)
    shown.setAlwaysOnTop(true, TOP_LEVEL)
  }

  function settleStyles() {
    restoreTopmost()
    clearTimeout(styleTimer)
    styleTimer = setTimeout(() => {
      restoreTopmost()
      const shown = live()
      if (shown) shown.setIgnoreMouseEvents(ignoring)
    }, 0)
  }

  // Native hit testing has no pointer-polling gap: the first press inside the island reaches it,
  // while the transparent area outside this region belongs to the window underneath.
  function shape() {
    const shown = live()
    if (process.platform !== 'win32' || !shown || !islandRect) return
    const bounds = shown.getBounds()
    if (drag && drag.layout !== 'compact' && drag.layout !== 'fixed') return
    const anchor = drag?.layout === 'fixed' ? drag.origin.anchor : { x: bounds.width / 2, y: bounds.height / 2 }
    const hit = drag ? [{ x: anchor.x - 40, y: anchor.y - 40, width: 80, height: 80 }] : regions.length ? regions : [islandRect]
    const shapes = hit.map(rect => {
      const x = Math.max(0, Math.floor(rect.x - POINTER_SLOP))
      const y = Math.max(0, Math.floor(rect.y - POINTER_SLOP))
      const right = Math.min(bounds.width, Math.ceil(rect.x + rect.width + POINTER_SLOP))
      const bottom = Math.min(bounds.height, Math.ceil(rect.y + rect.height + POINTER_SLOP))
      return { x, y, width: right - x, height: bottom - y }
    }).filter(rect => rect.width > 0 && rect.height > 0)
    if (!shapes.length) return
    if (!appliedShape || appliedShape.window !== shown || shapes.length !== appliedShape.rects.length || shapes.some((rect, i) => {
      const before = appliedShape!.rects[i]
      return rect.x !== before.x || rect.y !== before.y || rect.width !== before.width || rect.height !== before.height
    })) {
      shown.setShape(shapes)
      appliedShape = { window: shown, rects: shapes }
    }
    setIgnoring(false)
  }

  function send() {
    const shown = live()
    if (!shown || !loaded || !form) return
    const bounds = shown.getBounds()
    const anchor = drag?.layout === 'compact' ? { x: DRAG_SIZE.width / 2, y: DRAG_SIZE.height / 2 } : layout?.anchor
    const area = screen.getDisplayNearestPoint({ x: Math.round(bounds.x + (anchor?.x ?? 60)), y: Math.round(bounds.y + (anchor?.y ?? 50)) }).workArea
    shown.webContents.send('island:view', {
      view, form, align: layout?.align ?? 'center', dir: layout?.dir ?? 'down', dragging: Boolean(drag), coach: !coached, hover: hovering, layoutVersion,
      expanded: input && !drag, panel,
      anchor,
      side: layout?.side ?? 'right', panelWidth: layout?.panelWidth ?? 440,
      viewport: { top: area.y - bounds.y, bottom: area.y + area.height - bounds.y },
    })
  }

  /** The display the island was last dragged to, while it is connected; else the one the app's window is on. */
  function currentDisplay() {
    const last = places.last && screen.getAllDisplays().find((display) => String(display.id) === places.last)
    return last || screen.getDisplayMatching(mainWindow.getBounds())
  }

  function place(shown: Win) {
    const display = currentDisplay()
    const next = deskLayout(pointOf(places.places[String(display.id)], display.workArea), display.workArea)
    layout = next
    shown.setBounds(next.bounds)
  }

  function setIgnoring(value: boolean) {
    const shown = live()
    if (value === ignoring || !shown) return
    ignoring = value
    shown.setIgnoreMouseEvents(value)
  }

  /**
   * Clicks and dropped files reach the island only while the pointer is over it. The pointer is checked from
   * here rather than from the page, which hears nothing while it lets the pointer through; the page hears
   * from here whether the pointer rests on the island (`hover`).
   */
  function checkPointer() {
    const shown = live()
    if (!shown || !shown.isVisible()) return
    if (drag) return setIgnoring(false)
    if (!islandRect) return setIgnoring(true)
    const bounds = shown.getBounds()
    const cursor = screen.getCursorScreenPoint()
    const local = { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
    const inside = (regions.length ? regions : [islandRect]).some(rect => within(local, rect))
    if (process.platform !== 'win32') setIgnoring(!inside)
    return setHovering(inside)
  }

  /** The page shows the island's tools under a resting pointer; done waits while the pointer rests on it. */
  function setHovering(value: boolean) {
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
    let shown = live()
    if (!shown) {
      loaded = false
      ignoring = true
      const opened: Win = openWindow({ BrowserWindow, preload, page })
      win = opened
      shown = opened
      opened.webContents.on('did-finish-load', () => {
        if (live() !== opened) return
        loaded = true
        send()
        if (input) takeKeyboard()
      })
      opened.on('focus', () => { if (live() === opened) settleStyles() })
      opened.on('blur', () => {
        if (live() !== opened) return
        if (input) closeInput()
        settleStyles()
      })
      opened.on('closed', () => forgetWindow(opened))
      opened.webContents.on('render-process-gone', () => {
        forgetWindow(opened)
        if (!opened.isDestroyed()) opened.destroy()
      })
    }
    if (shown.isVisible()) return
    place(shown)
    shown.showInactive()
    settleStyles()
    clearInterval(pointerTimer)
    pointerTimer = setInterval(checkPointer, POINTER_MS)
  }

  /**
   * Gone, the island's window is closed rather than hidden, and made anew when it comes back. On Windows a
   * transparent window hidden and shown again lost its left button presses (found by DeepSeek at 175%); a new
   * one takes them, as the first one did.
   */
  function hide() {
    clearInterval(pointerTimer)
    clearTimeout(styleTimer)
    clearTimeout(layoutTimer)
    layoutVersion++
    awaitingLayout = false
    const shown = live()
    if (!shown) return
    win = null
    if ([...imports.values()].some(held => held.window === shown)) {
      retired.add(shown)
      shown.hide()
    } else shown.destroy()
    islandRect = null
    regions = []
    appliedShape = null
    drag = null
    hovering = false
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

  /**
   * Windows keeps its activation style stable; other platforms only take the keyboard for input.
   * Reassert the native level after changing focusability.
   */
  function setFocusable(shown: Win, value: boolean) {
    if (process.platform !== 'win32') shown.setFocusable(value)
    settleStyles()
  }

  /** A window focused before its page has loaded loses the focus again as it loads; so only once it has. */
  function takeKeyboard() {
    const shown = live()
    if (!shown || !loaded) return
    setFocusable(shown, true)
    shown.focus()
    settleStyles()
  }

  /** @param {{ sent?: boolean }} [options] sent: what was asked keeps the island up until it is done */
  function closeInput({ sent = false } = {}) {
    if (!input) return
    input = false
    summoned = summoned && sent
    const shown = live()
    if (shown) {
      if (shown.isFocused()) shown.blur()
      setFocusable(shown, false)
    }
    refresh()
  }

  /**
   * One step of a drag, at a frame of the page: the window follows the pointer, if it moved. Its size is given
   * at every step, not just its position: on Windows at a fractional scale (175%) `setPosition` rounds the
   * size it keeps, and the window grows a little at every move.
   */
  function dragMove() {
    const shown = live()
    if (!shown || !drag || drag.layout === 'waiting') return
    const cursor = screen.getCursorScreenPoint()
    if (drag.cursor?.x === cursor.x && drag.cursor?.y === cursor.y) return
    const display = screen.getDisplayNearestPoint(cursor)
    const point = keepInside({ x: cursor.x - drag.grab.x, y: cursor.y - drag.grab.y }, display.workArea)
    shown.setBounds(drag.layout === 'compact' || drag.layout === 'fixed' ? dragBounds(point) : {
      x: Math.round(point.x - drag.origin.anchor.x), y: Math.round(point.y - drag.origin.anchor.y), ...DESK_SIZE,
    })
    drag = { ...drag, cursor }
  }

  return {
    /** The window's island changed. */
    setView(next: DeskView) {
      if (next.form === 'done' && view?.form !== 'done') doneAt = Date.now()
      view = next
      refresh()
    },
    /** Whether the app's window was closed to the tray; shown again, it has its own island and input. */
    setAway(value: boolean) {
      onOwnership(value ? 'desk' : 'main')
      away = value
      if (value) hidden = false
      if (!value) closeInput()
      refresh()
    },
    /** Where the island is inside its window (the page reports it whenever its shape changes). */
    setIslandRect(rect: Rect, version?: number, ready = false, hitRegions: Rect[] = []) {
      if (version !== undefined && version !== layoutVersion) return
      if (awaitingLayout && (version !== layoutVersion || !ready)) return
      if (drag && drag.layout !== 'compact' && drag.layout !== 'fixed') {
        if (!ready || version === undefined || rect.width <= 0 || rect.height <= 0 || rect.width > DRAG_SIZE.width || rect.height > DRAG_SIZE.height) return
        clearTimeout(layoutTimer)
        drag.layout = 'compact'
        drag.cursor = null
        dragMove()
        send()
      }
      awaitingLayout = false
      islandRect = rect
      regions = hitRegions
      shape()
      checkPointer()
    },
    /** The shortcut, or files dropped on the island: open the input and take the keyboard. */
    openInput() {
      if (!away && !forced) return false
      input = true
      onOwnership('desk')
      panel = 'input'
      summoned = summoned || !enabled
      markCoached()
      refresh()
      takeKeyboard()
      return true
    },
    closeInput,
    openPanel(next: 'input' | 'request' | 'background' | 'status') {
      if (!away && !forced) return false
      input = true
      onOwnership('desk')
      panel = next
      markCoached()
      refresh()
      takeKeyboard()
      return true
    },
    togglePanel() {
      if (input) return closeInput()
      const next = view?.form === 'waiting' || view?.form === 'asking' ? 'request'
        : view?.form === 'done' || view?.form === 'error' || view?.form === 'pending' ? 'status'
        : view?.form !== 'working' && view?.background?.items?.length ? 'background' : 'input'
      return this.openPanel(next)
    },
    inputOpen: () => input,
    /** Follow the grab point; Windows keeps the same canvas and local portrait anchor throughout. */
    startDrag(start?: Point) {
      const shown = live()
      if (drag || !shown || !layout) return
      markCoached()
      const bounds = shown.getBounds()
      const pressed = start ?? screen.getCursorScreenPoint()
      drag = { cursor: null, layout: FIXED_DESK_HOST ? 'fixed' : 'waiting', origin: layout, expanded: input,
        grab: { x: pressed.x - bounds.x - layout.anchor.x, y: pressed.y - bounds.y - layout.anchor.y } }
      layoutVersion++
      awaitingLayout = true
      if (FIXED_DESK_HOST) shape()
      setIgnoring(false)
      send()
      takeKeyboard()
      if (FIXED_DESK_HOST) { dragMove(); return }
      layoutTimer = setTimeout(() => {
        if (drag?.layout !== 'waiting') return
        drag.layout = 'full'
        dragMove()
      }, LAYOUT_READY_MS)
    },
    dragMove,
    endDrag(cancel = false) {
      if (!drag) return
      clearTimeout(layoutTimer)
      const cursor = screen.getCursorScreenPoint()
      const display = screen.getDisplayNearestPoint(cursor)
      const point = keepInside({ x: cursor.x - drag.grab.x, y: cursor.y - drag.grab.y }, display.workArea)
      const previous = drag
      drag = null
      if (!FIXED_DESK_HOST) { islandRect = null; regions = [] }
      layoutVersion++
      awaitingLayout = true
      input = cancel && previous.expanded
      if (!cancel) {
        places = withPlace(places, display.id, settle(point, display.workArea))
        placeStore.set(places)
      }
      const shown = live()
      if (shown) {
        if (!FIXED_DESK_HOST) setIgnoring(true)
        if (cancel) { layout = previous.origin; shown.setBounds(layout.bounds) }
        else place(shown)
      }
      refresh()
      if (shown && !input) {
        if (shown.isFocused()) shown.blur()
        setFocusable(shown, false)
      }
    },
    placeAt(corner: string) {
      const display = currentDisplay(), area = display.workArea
      const point = { x: corner.startsWith('right') ? area.x + area.width - 60 : area.x + 60,
        y: corner.endsWith('bottom') ? area.y + area.height - 60 : area.y + 60 }
      places = withPlace(places, display.id, settle(point, area))
      placeStore.set(places)
      const shown = live()
      if (shown) { layoutVersion++; awaitingLayout = true; place(shown); send() }
    },
    /** Settings: back to the top centre, on every display. */
    resetPlace() {
      places = readPlaces(null)
      placeStore.set(places)
      const shown = live()
      if (shown?.isVisible()) {
        layoutVersion++
        awaitingLayout = true
        place(shown)
        send()
      }
    },
    /** The user has seen what the island can do: the first-time note goes for good. */
    markCoached,
    /** The right-click menu, over the island. */
    popup(menu: Pick<Menu, 'popup'>) {
      const shown = live()
      if (shown?.isVisible()) menu.popup({ window: shown })
    },
    working: () => view?.form === 'working' && view?.target?.working !== false,
    sendDraft(draft: unknown) { const shown = live(); if (shown && loaded) shown.webContents.send('draft:changed', draft) },
    /** 先隐藏 in its menu: gone until the window is next closed to the tray; the shortcut still calls it up. */
    hideUntilAway() {
      hidden = true
      refresh()
    },
    /** The user's switch in settings, or 不再显示桌面岛 in its menu. */
    setEnabled(value: boolean) {
      enabled = value
      refresh()
    },
    /** For the smoke run, whose window is never in front: show the island as if it were away. */
    force(on: boolean) {
      forced = on
      onOwnership(on || away ? 'desk' : 'main')
      refresh()
    },
    owns: (sender: WebContents) => {
      const shown = live()
      return Boolean(shown && sender === shown.webContents)
    },
    beginImport(sender: WebContents, key: string) {
      const shown = live()
      if (!shown || sender !== shown.webContents) return null
      const ticket = randomUUID()
      imports.set(ticket, { sender, key, window: shown })
      return ticket
    },
    claimImport(sender: WebContents, key: string, ticket: string) {
      const held = imports.get(ticket)
      if (!held || held.sender !== sender || held.key !== key) return false
      releaseImport(ticket)
      return true
    },
    endImport(sender: WebContents, ticket: string) {
      const held = imports.get(ticket)
      if (!held || held.sender !== sender) return null
      releaseImport(ticket)
      return held.key
    },
    webContents: () => live()?.webContents ?? null,
    destroy() {
      clearTimeout(timer)
      clearInterval(pointerTimer)
      clearTimeout(styleTimer)
      clearTimeout(layoutTimer)
      drag = null
      imports.clear()
      for (const opened of retired) if (!opened.isDestroyed()) opened.destroy()
      retired.clear()
      live()?.destroy()
      win = null
    },
  }
}
