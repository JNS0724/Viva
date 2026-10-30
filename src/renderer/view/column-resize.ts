/**
 * The conversation column's width (the thread, the earlier part, the topic label and the input share it, styles.css
 * --col): dragged wider or narrower at either edge, double-clicked back to the default, and kept for the next launch.
 */
/**
 * The lane at each side of the main area the column never takes: on the left the turn rail (view/turn-rail.ts) lives
 * there, so the widest column still leaves the rail clear of the text; the column is centred, so the right keeps as
 * much. styles.css --rail-lane.
 */
export const RAIL_LANE = 40
/** styles.css .main's padding at each side, inside which the conversation scrolls. */
const MAIN_PADDING_PX = 28
/**
 * Room right of a message for its star (styles.css .star-btn, 38px out) and the conversation's scrollbar (10px,
 * ::-webkit-scrollbar), so the widest column never scrolls sideways.
 */
const STAR_GUTTER_PX = 48
/** The margin left over at the widest: padding and the star's gutter at each side, which also keeps the rail's lane. */
export const COLUMN = Object.freeze({ default: 760, min: 560, margin: 2 * (MAIN_PADDING_PX + STAR_GUTTER_PX) })
const STORE_KEY = 'viva:column-width'

/** The width to use for `wanted` in a column area `available` wide: never narrower than reads well, never past the window. */
export function clampColumn(wanted: number, available: number): number {
  if (!Number.isFinite(wanted)) return COLUMN.default
  return Math.max(COLUMN.min, Math.min(wanted, available - COLUMN.margin))
}

/** The free space right of the column, where the dock floats (the rail is on the other side). */
export const sideBeside = (column: number, area: number): number => (area - column) / 2

function saved(): number {
  try {
    return Number(localStorage.getItem(STORE_KEY) ?? Number.NaN)
  } catch {
    return Number.NaN
  }
}

function keep(width: number | null) {
  try {
    if (width === null) localStorage.removeItem(STORE_KEY)
    else localStorage.setItem(STORE_KEY, String(Math.round(width)))
  } catch {
    // Storage refused (a private profile): the width holds for this launch only.
  }
}

/** How far one arrow key moves a grip. */
const KEY_STEP_PX = 40

/**
 * Wires the two grips at the column's edges inside `area` (the main area the column is centred in). Each grip takes
 * the pointer (drag; double-click for the default) and the keyboard (arrows widen or narrow it, Home for the default).
 * @param onWidth told the width in use after every change, with the area's width (what is left beside the column)
 * @returns fit: re-applies the width, for when the area itself changes size; reset: back to the default
 */
export function attachColumnResize(area: HTMLElement, grips: readonly HTMLElement[], onWidth: (column: number, area: number) => void = () => {}) {
  const root = document.documentElement
  let width = Number.isFinite(saved()) ? saved() : COLUMN.default
  const apply = () => {
    // Read before changing the inherited width; a second read would force layout of the conversation.
    const available = area.clientWidth
    const column = clampColumn(width, available)
    root.style.setProperty('--col', `${column}px`)
    for (const grip of grips) grip.setAttribute('aria-valuenow', String(column))
    onWidth(column, available)
  }
  const reset = () => {
    width = COLUMN.default
    apply()
    keep(null)
  }
  apply()

  for (const grip of grips) {
    grip.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      try {
        grip.setPointerCapture(event.pointerId)
      } catch {
        // A pointer that is not the system's (a test dispatching events) cannot be captured; moves still reach the grip.
      }
      document.body.classList.add('col-resizing')
      const box = area.getBoundingClientRect()
      const centre = box.left + box.width / 2
      const move = (moved: PointerEvent) => {
        width = clampColumn(Math.abs(moved.clientX - centre) * 2, area.clientWidth)
        apply()
      }
      const end = () => {
        grip.removeEventListener('pointermove', move)
        document.body.classList.remove('col-resizing')
        keep(width)
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', end, { once: true })
      grip.addEventListener('pointercancel', end, { once: true })
    })
    grip.addEventListener('dblclick', reset)
    // The left grip widens the column to the left, the right one to the right; either way the column grows on both sides.
    const outward = grip.dataset.side === 'left' ? 'ArrowLeft' : 'ArrowRight'
    const inward = grip.dataset.side === 'left' ? 'ArrowRight' : 'ArrowLeft'
    grip.addEventListener('keydown', (event) => {
      if (event.key === 'Home') return reset()
      if (event.key !== outward && event.key !== inward) return
      event.preventDefault()
      width = clampColumn(clampColumn(width, area.clientWidth) + (event.key === outward ? 2 : -2) * KEY_STEP_PX, area.clientWidth)
      apply()
      keep(width)
    })
  }
  return { fit: apply, reset }
}
