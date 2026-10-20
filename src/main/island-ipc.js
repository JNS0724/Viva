/**
 * What crosses between the window, the main process and the desktop island (desk-island.js). The view
 * comes from the window's renderer; the actions come from the desktop island's page. Both are checked here,
 * and an action names exactly what it answers, so a click on the island can do no more than its buttons.
 */
const FORMS = new Set(['pending', 'idle', 'working', 'waiting', 'asking', 'done', 'error'])
const MAX_VIEW_CHARS = 20_000
const MAX_ID_CHARS = 200
const MAX_LABEL_CHARS = 200

const isText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max

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
  pointer: ({ inside }) => (typeof inside === 'boolean' ? { kind: 'pointer', inside } : null),
  permission: ({ requestId, optionId }) => (isText(requestId, MAX_ID_CHARS) && isText(optionId, MAX_ID_CHARS)
    ? { kind: 'permission', requestId, optionId }
    : null),
  answer: ({ questionId, id, label }) => (isText(questionId, MAX_ID_CHARS) && isText(id, MAX_ID_CHARS) && isText(label, MAX_LABEL_CHARS)
    ? { kind: 'answer', questionId, id, label }
    : null),
}

/** @returns {object | null} only the fields the action's kind uses, or null for anything else */
export function checkIslandAction(action) {
  if (!action || typeof action !== 'object' || !Object.hasOwn(ACTIONS, action.kind)) return null
  return ACTIONS[action.kind](action)
}
