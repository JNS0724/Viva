import { islandView } from '../island-view.js'
import { createIsland } from './island-dom.js'

/** The one island in the title bar, kept across renders so its changes of shape animate. */
let island = null

/**
 * The island centred in the title bar: overall progress beside the cat; hovering or clicking it unfolds the
 * latest steps. While the agent waits on the user it says so and leads to the card in the thread, which
 * alone carries what is asked.
 */
export function renderIsland(container, state, handlers, now) {
  island ??= createIsland('bar', (action) => handlers.islandAction(action))
  if (island.el.parentNode !== container) container.replaceChildren(island.el)
  island.update(islandView(state), { now, pinned: state.island })
}
