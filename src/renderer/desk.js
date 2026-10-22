import { createIsland } from './view/island-dom.js'
import { createIslandInput } from './view/island-input.js'

/**
 * The page of the desktop island's window (src/main/desk-island.js): the same island as in the title bar,
 * fed by the main process with what the window's island shows. Clicks go back as actions; the main process
 * checks them and passes them on to the window. Here too: the input (the shortcut, a click on the resting
 * cat, or files dropped on the island), moving the island, which the main process does while the user holds
 * it, its right-click menu, which the main process shows, and the first-time note on what it can do.
 */
const TICK_MS = 1000
/** Moved this far with the button down, a press on the island is a drag, not a click. */
const DRAG_START_PX = 4
const MAX_FILES = 10
const IDLE_VIEW = Object.freeze({ form: 'idle', tone: 'idle', mood: 'idle', label: '', recent: [] })
const api = window.desk

/**
 * From the main process: the window's view, the form to show, where the island sits, whether it is dragged,
 * whether the user has yet to see what it can do (coach).
 */
let payload = null
/** The input's own state: files dropped so far, the last refusal, files being dragged over (their count). */
let files = []
let error = null
let dropping = 0

const input = createIslandInput({
  send: (text) => ask(text),
  dismiss: () => api.act({ kind: 'dismiss' }),
  removeFile: (path) => {
    files = files.filter((file) => file.path !== path)
    show()
  },
})
const island = createIsland('desk', (action) => api.act(action), { input, shortcut: api.shortcut })
const stage = document.getElementById('desk')
stage.append(island.el)

/** Why the input cannot take a question now, if it cannot. */
function busyOf(view) {
  return view.form === 'pending' ? { text: '还没连上，先打开窗口看看' } : null
}

/** What the island shows now, from what the main process said and what happens on this page. */
function shownView() {
  const view = payload?.view ?? IDLE_VIEW
  if (dropping) return { form: 'drop', tone: 'done', mood: 'idle', label: '交给 Viva', recent: [], count: dropping }
  if (payload?.dragging) return { ...view, form: 'mini', tone: 'idle', mood: 'idle', dragging: true }
  // While the agent waits on the user the input steps aside: what it waits on comes first.
  if (payload?.form === 'input' && view.form !== 'waiting' && view.form !== 'asking') {
    // While the agent works, what is asked goes into the turn it is on.
    return { form: 'input', tone: 'done', mood: 'idle', label: '问 Viva', recent: [], busy: busyOf(view), steering: view.form === 'working', files, error }
  }
  if (payload?.form === 'mini' && payload.coach) return { form: 'coach', tone: 'done', mood: 'idle', label: 'Viva 在这儿', recent: [] }
  return payload?.form === 'mini' ? { ...view, form: 'mini', tone: 'idle', mood: 'idle' } : view
}

/** The 后台 list, opened by a click on the count at the island's tail; it closes when no task is left. */
let listOpen = false

function show() {
  if (!payload && !dropping) return
  const view = shownView()
  if (!view.background?.items.length) listOpen = false
  island.update(view, { now: Date.now(), pinned: listOpen })
  if (view.form === 'input' && !view.busy && document.activeElement !== input.field) input.field.focus()
}

async function ask(text) {
  error = null
  const result = await api.ask(text, files.map((file) => file.path))
  if (result.ok) {
    input.clear()
    files = []
  } else error = result.error
  show()
}

api.onView((next) => {
  if (payload?.form === 'input' && next.form !== 'input') {
    files = []
    error = null
  }
  payload = next
  Object.assign(stage.dataset, { align: next.align, dir: next.dir, dragging: String(Boolean(next.dragging)) })
  island.el.dataset.dir = next.dir
  island.setPointer(Boolean(next.hover))
  show()
})
setInterval(show, TICK_MS)

// The main process lets clicks through to what is below except over the island, so it needs to know where
// the island is; that changes with every change of shape and place.
function reportRect() {
  const { x, y, width, height } = island.el.getBoundingClientRect()
  api.act({ kind: 'rect', x, y, width, height })
}
new ResizeObserver(reportRect).observe(island.el)
new MutationObserver(reportRect).observe(stage, { attributes: true, attributeFilter: ['data-align', 'data-dir', 'data-dragging'] })

// Holding the island and moving it drags it; the main process moves the window with the pointer, and the
// island shrinks to its cat meanwhile. It moves at this page's frames, so in step with the screen at any
// refresh rate, and not at all while the pointer rests. The click that ends a drag is not a click on the island.
let press = null
let dragged = false
let frame = 0
function dragFrame() {
  api.act({ kind: 'drag', phase: 'move' })
  frame = requestAnimationFrame(dragFrame)
}
island.el.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('textarea, button:not(.isl-head)')) return
  press = { x: event.screenX, y: event.screenY, id: event.pointerId }
  dragged = false
})
island.el.addEventListener('pointermove', (event) => {
  if (!press || dragged || event.pointerId !== press.id) return
  if (Math.hypot(event.screenX - press.x, event.screenY - press.y) < DRAG_START_PX) return
  dragged = true
  island.el.setPointerCapture(press.id)
  api.act({ kind: 'drag', phase: 'start' })
  frame = requestAnimationFrame(dragFrame)
})
const endPress = () => {
  cancelAnimationFrame(frame)
  if (dragged) api.act({ kind: 'drag', phase: 'end' })
  press = null
}
island.el.addEventListener('pointerup', endPress)
island.el.addEventListener('pointercancel', endPress)
island.el.addEventListener('click', (event) => {
  if (!dragged) return
  dragged = false
  event.stopPropagation()
  event.preventDefault()
}, true)

/** Forms in which the island shows what waits on the user: that comes first, and the count opens the window. */
const SHOWS_WAITING = new Set(['waiting', 'asking'])

// The count at the tail opens the 后台 list here while tasks go on; otherwise (all ended, or something waits on
// the user) it goes on to the island's own handler, which opens the window on its 后台 page.
island.el.addEventListener('click', (event) => {
  const view = shownView()
  if (!event.target.closest('.isl-bg') || SHOWS_WAITING.has(view.form) || !view.background?.items.length) return
  event.stopPropagation()
  event.preventDefault()
  listOpen = !listOpen
  show()
}, true)

// The right-click menu is the main process's: a menu of the system's, not of the page.
island.el.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  api.act({ kind: 'menu' })
})

// Files dragged from any app onto the island: it opens to take them, and dropping opens the input with them.
// While files are over it the page hears dragover again and again; when that stops, they have gone.
const DRAG_GONE_MS = 300
const hasFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
let dropTimer = null
const stopDropping = () => {
  clearTimeout(dropTimer)
  if (!dropping) return
  dropping = 0
  show()
}
island.el.addEventListener('dragenter', (event) => {
  if (hasFiles(event)) event.preventDefault()
})
island.el.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
  clearTimeout(dropTimer)
  dropTimer = setTimeout(stopDropping, DRAG_GONE_MS)
  if (dropping) return
  dropping = event.dataTransfer.items?.length || 1
  show()
})
island.el.addEventListener('dragleave', (event) => {
  if (!island.el.contains(event.relatedTarget)) stopDropping()
})
island.el.addEventListener('drop', async (event) => {
  if (!hasFiles(event)) return
  event.preventDefault()
  clearTimeout(dropTimer)
  dropping = 0
  const result = await api.describeFiles([...event.dataTransfer.files])
  if (result.error) error = result.error
  else {
    const known = new Set(files.map((file) => file.path))
    files = [...files, ...result.files.filter((file) => !known.has(file.path))].slice(0, MAX_FILES)
    error = null
  }
  api.act({ kind: 'input' })
  show()
})
// Esc closes the input even while its field cannot be typed in (the agent is busy).
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && payload?.form === 'input') api.act({ kind: 'dismiss' })
})
