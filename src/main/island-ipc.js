/**
 * What crosses between the window, the main process and the desktop island (desk-island.js). The view
 * comes from the window's renderer; the actions come from the desktop island's page. Both are checked here,
 * and an action names exactly what it answers, so a click on the island can do no more than its buttons.
 */
const FORMS = new Set(['pending', 'idle', 'working', 'waiting', 'asking', 'done', 'error'])
const MAX_VIEW_CHARS = 20_000
const MAX_ID_CHARS = 200
const MAX_LABEL_CHARS = 200

/** What the island's input may send: a question of this length, with at most this many files. */
export const ASK_LIMITS = Object.freeze({ chars: 4000, files: 10, pathChars: 1024 })
/** The island's place in its window, in pixels (desk-place.js DESK_SIZE, with room to spare). */
const MAX_RECT_PX = 2000

const DRAG_PHASES = new Set(['start', 'move', 'end'])

const isText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
const isPx = (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_RECT_PX

/** @returns {object | null} the view as given, or null when it is not one */
export function checkIslandView(view) {
  if (!view || typeof view !== 'object' || !FORMS.has(view.form)) return null
  if (typeof view.label !== 'string' || !Array.isArray(view.recent)) return null
  try {
    return JSON.stringify(view).length <= MAX_VIEW_CHARS ? view : null
  } catch {
    return null
  }
}

const ACTIONS = {
  open: () => ({ kind: 'open' }),
  cancel: () => ({ kind: 'cancel' }),
  /** Files dropped on the island, or the input closed with Esc. */
  input: () => ({ kind: 'input' }),
  dismiss: () => ({ kind: 'dismiss' }),
  /** The right-click menu, and the first-time note seen. */
  menu: () => ({ kind: 'menu' }),
  coached: () => ({ kind: 'coached' }),
  rect: ({ x, y, width, height }) => ([x, y, width, height].every(isPx) && width >= 0 && height >= 0
    ? { kind: 'rect', x, y, width, height }
    : null),
  /** Held and moved: start, a move at each frame the page draws meanwhile, end. */
  drag: ({ phase }) => (DRAG_PHASES.has(phase) ? { kind: 'drag', phase } : null),
  permission: ({ requestId, optionId }) => (isText(requestId, MAX_ID_CHARS) && isText(optionId, MAX_ID_CHARS)
    ? { kind: 'permission', requestId, optionId }
    : null),
  answer: ({ questionId, id, label }) => (isText(questionId, MAX_ID_CHARS) && isText(id, MAX_ID_CHARS) && isText(label, MAX_LABEL_CHARS)
    ? { kind: 'answer', questionId, id, label }
    : null),
  /** 跳过: the question goes unanswered, as from the thread's card. */
  skip: ({ questionId }) => (isText(questionId, MAX_ID_CHARS) ? { kind: 'skip', questionId } : null),
}

/** @returns {object | null} only the fields the action's kind uses, or null for anything else */
export function checkIslandAction(action) {
  if (!action || typeof action !== 'object' || !Object.hasOwn(ACTIONS, action.kind)) return null
  return ACTIONS[action.kind](action)
}

/** @returns {string[] | null} paths of files dropped on the island, or null when they are not that */
export function checkDroppedPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > ASK_LIMITS.files) return null
  return paths.every((item) => isText(item, ASK_LIMITS.pathChars)) ? [...paths] : null
}

/** @returns {{ text: string, files: string[] } | null} a question from the island's input */
export function checkAsk(ask) {
  if (!ask || typeof ask !== 'object' || !isText(ask.text?.trim?.(), ASK_LIMITS.chars)) return null
  const files = ask.files ?? []
  if (!Array.isArray(files) || (files.length > 0 && !checkDroppedPaths(files))) return null
  return { text: ask.text.trim(), files: [...files] }
}
