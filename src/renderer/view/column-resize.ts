/**
 * The conversation column's width (the thread, the earlier part, the topic label and the input share it, styles.css
 * --col): dragged wider or narrower at either edge, double-clicked back to the default, and kept for the next launch.
 */
export const COLUMN = Object.freeze({ default: 760, min: 560, margin: 56 })
const STORE_KEY = 'viva:column-width'

/** The width to use for `wanted` in a column area `available` wide: never narrower than reads well, never past the window. */
export function clampColumn(wanted: number, available: number): number {
  if (!Number.isFinite(wanted)) return COLUMN.default
  return Math.max(COLUMN.min, Math.min(wanted, available - COLUMN.margin))
}

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

/**
 * Wires the two grips at the column's edges inside `area` (the main area the column is centred in).
 * @param onWidth told the width in use after every change, with the area's width (what is left beside the column)
 * @returns re-applies the width, for when the area itself changes size
 */
export function attachColumnResize(area: HTMLElement, grips: readonly HTMLElement[], onWidth: (column: number, area: number) => void = () => {}) {
  const root = document.documentElement
  let width = Number.isFinite(saved()) ? saved() : COLUMN.default
  const apply = () => {
    const column = clampColumn(width, area.clientWidth)
    root.style.setProperty('--col', `${column}px`)
    onWidth(column, area.clientWidth)
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
    grip.addEventListener('dblclick', () => {
      width = COLUMN.default
      apply()
      keep(null)
    })
  }
  return apply
}
