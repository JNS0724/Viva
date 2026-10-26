/** rAF pauses in occluded windows. Keep model/render work progressing, without executing either path twice. */
export const FRAME_DEADLINE_MS = 50

export function createFrameScheduler({
  request = (run: FrameRequestCallback) => requestAnimationFrame(run),
  cancel = (id: number) => cancelAnimationFrame(id),
  later = setTimeout, clear = clearTimeout, now = () => performance.now(),
}: {
  request?: (run: FrameRequestCallback) => number,
  cancel?: (id: number) => void,
  later?: typeof setTimeout, clear?: typeof clearTimeout, now?: () => number,
} = {}) {
  return (run: FrameRequestCallback): (() => void) => {
    let active = true
    let frame: number | undefined
    const timer = later(() => finish(now()), FRAME_DEADLINE_MS)
    function stop() {
      if (frame !== undefined) cancel(frame)
      clear(timer)
    }
    function finish(time: number) {
      if (!active) return
      active = false
      stop()
      run(time)
    }
    frame = request(finish)
    return () => { active = false; stop() }
  }
}

export const scheduleFrame = createFrameScheduler()
