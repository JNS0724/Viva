/**
 * Where the desktop island sits (desk-island.js). By default at the top centre of the screen; the user may
 * drag it anywhere, and it is remembered per display as the centre of its head, in fractions of the
 * display's work area. Near the top centre it snaps home. In the lower half it unfolds upwards, and near a
 * side it keeps to that side, so whatever it unfolds into stays on the screen.
 *
 * The island's window is larger than the island (DESK_SIZE); the island sits at the top or the bottom of it
 * (`dir`), at its left, centre or right (`align`), with STAGE_PAD around (island.css .desk-stage).
 */
export const DESK_SIZE = Object.freeze({ width: 600, height: 320 })
/** The island's head (island-dom.js SIZES.desk.head) and the room around it in the window. */
const HEAD = 48
export const STAGE_PAD = Object.freeze({ side: 20, end: 10 })
/** The home place: this far below the top of the work area. */
const TOP_GAP = 6
/** Dropped this close to home, the island goes home. */
const SNAP_PX = 48

/** @typedef {{ x: number, y: number, width: number, height: number }} Area */
/** @typedef {{ x: number, y: number }} Point the centre of the island's head, on the screen */
/** @typedef {{ fx: number, fy: number }} Place a point as fractions of a work area */
/** @typedef {{ last: string | null, places: Record<string, Place> }} Places what preferences.json keeps */

/** @param {Area} area @returns {Point} */
export function homePoint(area) {
  return { x: area.x + area.width / 2, y: area.y + TOP_GAP + STAGE_PAD.end + HEAD / 2 }
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

/** A point kept inside the work area, so the head is never off the screen. */
export function keepInside(point, area) {
  return {
    x: clamp(point.x, area.x + HEAD / 2, area.x + area.width - HEAD / 2),
    y: clamp(point.y, area.y + HEAD / 2, area.y + area.height - HEAD / 2),
  }
}

/**
 * @param {Point} point
 * @param {Area} area
 * @param {{ dragging?: boolean }} [options] while dragging the island stays under the pointer, near a side too
 * @returns {{ bounds: Area, align: 'start' | 'center' | 'end', dir: 'down' | 'up' }}
 */
export function deskLayout(point, area, { dragging = false } = {}) {
  const { width, height } = DESK_SIZE
  const dir = point.y > area.y + area.height / 2 ? 'up' : 'down'
  let align = 'center'
  if (!dragging && point.x - area.x < width / 2) align = 'start'
  else if (!dragging && area.x + area.width - point.x < width / 2) align = 'end'
  const x = { start: area.x, end: area.x + area.width - width, center: Math.round(point.x - width / 2) }[align]
  const y = dir === 'down' ? point.y - HEAD / 2 - STAGE_PAD.end : point.y + HEAD / 2 + STAGE_PAD.end - height
  const top = dragging ? Math.round(y) : Math.round(clamp(y, area.y, area.y + area.height - height))
  return { bounds: { x, y: top, width, height }, align, dir }
}

/** @returns {Place | null} where a dropped island stays; null when it went home */
export function settle(point, area) {
  const home = homePoint(area)
  if (Math.hypot(point.x - home.x, point.y - home.y) <= SNAP_PX) return null
  return { fx: (point.x - area.x) / area.width, fy: (point.y - area.y) / area.height }
}

/** @param {Place | null | undefined} place @param {Area} area @returns {Point} */
export function pointOf(place, area) {
  if (!place) return homePoint(area)
  return keepInside({ x: area.x + place.fx * area.width, y: area.y + place.fy * area.height }, area)
}

const isFraction = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

/** What preferences.json holds, with anything that is not a place left out. @returns {Places} */
export function readPlaces(raw) {
  const places = {}
  for (const [id, place] of Object.entries(raw?.places ?? {})) {
    if (isFraction(place?.fx) && isFraction(place?.fy)) places[id] = { fx: place.fx, fy: place.fy }
  }
  return { last: typeof raw?.last === 'string' ? raw.last : null, places }
}

/** @returns {Places} with the display's place set, or removed when it is home */
export function withPlace(places, displayId, place) {
  const id = String(displayId)
  const { [id]: _old, ...others } = places.places
  return { last: id, places: place ? { ...others, [id]: place } : others }
}
