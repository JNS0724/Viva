/**
 * When 已完成 stops being news (conversation-types.ts doneNotice). Done says something is ready to look at; once
 * looked at it has nothing more to say, and the island goes back to 待命. Looked at: the window in front with the user
 * on it (after her done pose has played once, so the change is seen), or the desktop island's card read and closed.
 * With nobody looking it stays 已完成, so nothing is missed, but her pose rests on its still after a couple of loops:
 * looping motion is for what goes on or waits on the user (ui-guidelines), and a finished turn does neither.
 */

/** One loop of her done pose (ui-guidelines: up, held, back down). */
export const DONE_LOOP_MS = 2590
/** Loops played with nobody looking before she holds the pose still. */
const LOOPS_UNWATCHED = 2

type Timer = ReturnType<typeof setTimeout>

export function createDoneNotice({ getState, dispatch, looking, setTimer = setTimeout, clearTimer = clearTimeout }: {
  getState: () => Pick<State, 'phase' | 'lastReceipt' | 'doneNotice'>
  dispatch: (action: { type: 'done_seen' | 'done_still' }) => void
  /** The window is in front and on screen: the user is on it. */
  looking: () => boolean
  setTimer?: (run: () => void, ms: number) => Timer
  clearTimer?: (timer: Timer) => void
}) {
  let pending: { type: 'done_seen' | 'done_still', timer: Timer } | null = null
  const cancel = () => {
    if (pending) clearTimer(pending.timer)
    pending = null
  }
  const after = (type: 'done_seen' | 'done_still', ms: number) => {
    if (pending?.type === type) return
    cancel()
    const timer = setTimer(() => {
      pending = null
      dispatch({ type })
    }, ms)
    pending = { type, timer }
  }

  /** After every change, and whenever the window is come to or left: what the done notice waits for now. */
  function check() {
    const state = getState()
    if (state.phase !== 'idle' || !state.lastReceipt || state.doneNotice === 'seen') return cancel()
    if (looking()) return after('done_seen', DONE_LOOP_MS)
    if (state.doneNotice === 'fresh') return after('done_still', DONE_LOOP_MS * LOOPS_UNWATCHED)
    cancel()
  }

  /** Looked at elsewhere (the desktop island's card read): no longer news, at once. */
  function seen() {
    cancel()
    const state = getState()
    if (state.lastReceipt && state.doneNotice !== 'seen') dispatch({ type: 'done_seen' })
  }

  return { check, seen }
}
