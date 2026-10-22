import { islandView } from '../island-view.ts'
import { createIsland } from './island-dom.ts'

/** The one island in the title bar, kept across renders so its changes of shape animate. */
let island: ReturnType<typeof createIsland> | null = null

/**
 * The island centred in the title bar: overall progress beside the cat; clicking it unfolds the latest
 * steps (a pointer passing over it does not). While the agent waits on the user it says so and leads to the card in the thread, which
 * alone carries what is asked.
 */
export function renderIsland(container: HTMLElement, state: State, handlers: Handlers, now: number) {
  const shown = (island ??= createIsland('bar', (action) => handlers.islandAction(action)))
  if (shown.el.parentNode !== container) container.replaceChildren(shown.el)
  shown.update(islandView(state), { now, pinned: state.island })
}
