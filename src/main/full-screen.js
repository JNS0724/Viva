/**
 * A full-screen window on macOS has a Space of its own; hidden as it is, it leaves that Space behind, black.
 * So a window going to the tray leaves full screen first and is hidden once it has.
 */
/** Should the system never say it has left full screen, the window goes anyway after this long. */
const LEAVE_TIMEOUT_MS = 1_500

/**
 * @param {{ setFullScreen: (on: boolean) => void, once: Function, removeListener: Function, isDestroyed: () => boolean }} win
 * @param {() => void} then what to do once the window has left full screen
 */
export function leaveFullScreen(win, then) {
  let timer = null
  const done = () => {
    clearTimeout(timer)
    win.removeListener('leave-full-screen', done)
    if (!win.isDestroyed()) then()
  }
  win.once('leave-full-screen', done)
  timer = setTimeout(done, LEAVE_TIMEOUT_MS)
  win.setFullScreen(false)
}
