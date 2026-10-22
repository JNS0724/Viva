/**
 * The page over the conversation, under the title bar (view/hub.js): 搜索, 关于你 or 设置, one at a time.
 * Each keeps its own slice (history, memory, settings) and its own open and close actions; this keeps
 * only one of them open and remembers which to open on next. Pure, like the rest of `state.js`.
 */
export const HUB_PAGES = Object.freeze(['search', 'profile', 'settings'])

export const initialHub = Object.freeze({
  /** The page it opens on when opened without naming one: the one last shown. */
  last: 'profile',
})

const IS_OPEN = {
  search: (state) => state.history.open,
  profile: (state) => state.memory.open,
  settings: (state) => state.settings.open,
}
const CLOSE_ACTION = { search: 'history_close', profile: 'memory_close', settings: 'settings_close' }

/** The page that is open, or null. */
export const hubPage = (state) => HUB_PAGES.find((page) => IS_OPEN[page](state)) ?? null

/**
 * After an action: a page it opened closes the one that was open and becomes the one to open on next.
 * @param {(state: object, action: object) => object} reduce the whole reducer, to close a page with its own action
 */
export function oneHubPage(before, after, reduce) {
  const opened = HUB_PAGES.find((page) => IS_OPEN[page](after) && !IS_OPEN[page](before))
  if (!opened) return after
  const remembered = after.hub.last === opened ? after : { ...after, hub: { ...after.hub, last: opened } }
  return HUB_PAGES
    .filter((page) => page !== opened && IS_OPEN[page](after))
    .reduce((state, page) => reduce(state, { type: CLOSE_ACTION[page] }), remembered)
}

/** ← 返回, Esc, or the 关于你 icon again: whichever page is open closes. */
export function closeHub(state, reduce) {
  const page = hubPage(state)
  return page ? reduce(state, { type: CLOSE_ACTION[page] }) : state
}
