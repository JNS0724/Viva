import { createIsland } from './view/island-dom.js'

/**
 * The page of the desktop island's window (src/main/desk-island.js): the same island as in the title bar,
 * fed by the main process with what the window's island shows. Clicks go back as actions; the main process
 * checks them and passes them on to the window.
 */
const TICK_MS = 1000
const api = window.desk
const island = createIsland('desk', (action) => api.act(action))
document.getElementById('desk').append(island.el)

let current = null
const show = () => current && island.update(current, { now: Date.now() })

/** After a turn the island rests as just the cat before it goes. */
const asShown = (view, form) => (form === 'mini' ? { ...view, form: 'mini', tone: 'idle', mood: 'idle' } : view)

api.onView(({ view, form }) => {
  current = asShown(view, form)
  show()
})
setInterval(show, TICK_MS)

// The window lets clicks through to what is below, except while the pointer is over the island.
island.el.addEventListener('mouseenter', () => api.act({ kind: 'pointer', inside: true }))
island.el.addEventListener('mouseleave', () => api.act({ kind: 'pointer', inside: false }))
