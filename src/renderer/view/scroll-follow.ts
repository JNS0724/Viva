/** How close to the bottom still counts as "at the bottom". */
const BOTTOM_SLACK_PX = 32
/** Breathing room kept above the latest question when a long answer stops auto-scrolling. */
const ANCHOR_GAP_PX = 24
const KEYS_THAT_SCROLL_UP = new Set(['PageUp', 'ArrowUp', 'Home'])

export const distanceFromBottom = (el: { scrollTop: number, scrollHeight: number, clientHeight: number }) => el.scrollHeight - el.scrollTop - el.clientHeight

/**
 * Where to scroll while following new output: the bottom, but never so far that the
 * latest question (at `anchorTop`) leaves the top of the viewport.
 */
export function followTarget({ scrollHeight, clientHeight, anchorTop }: { scrollHeight: number, clientHeight: number, anchorTop?: number | null }): { scrollTop: number, capped: boolean } {
  const bottom = Math.max(0, scrollHeight - clientHeight)
  if (anchorTop === null || anchorTop === undefined) return { scrollTop: bottom, capped: false }
  const cap = Math.max(0, anchorTop - ANCHOR_GAP_PX)
  return bottom > cap ? { scrollTop: cap, capped: true } : { scrollTop: bottom, capped: false }
}

/**
 * Scroll behaviour for the conversation:
 * - follows new output while the reader is at the bottom;
 * - stops once a long answer would push the latest question off screen, and shows the jump button;
 * - hands control to the reader the moment they scroll up, and resumes when they come back down.
 */
export function createScrollFollower(scrollEl: HTMLElement, jumpButton: HTMLElement) {
  let following = true
  let anchorSpent = false
  let lastWrite = Number.NaN
  const readerAnchoring = scrollEl.style.overflowAnchor
  // Only one controller owns anchoring at a time. Native scroll anchoring can move the offset after
  // our DOM update, which would otherwise look like the reader scrolling away before the next frame.
  const follow = (value: boolean) => {
    following = value
    scrollEl.style.overflowAnchor = value ? 'none' : readerAnchoring
  }
  follow(true)

  const updateJump = () => {
    jumpButton.hidden = following || distanceFromBottom(scrollEl) <= BOTTOM_SLACK_PX
  }

  const write = (top: number) => {
    scrollEl.scrollTop = top
    lastWrite = scrollEl.scrollTop
  }

  const yieldToReader = () => {
    follow(false)
    anchorSpent = true
    updateJump()
  }

  scrollEl.addEventListener('wheel', (event) => {
    if (event.deltaY < 0) yieldToReader()
  }, { passive: true })
  scrollEl.addEventListener('keydown', (event) => {
    if (KEYS_THAT_SCROLL_UP.has(event.key)) yieldToReader()
  })
  scrollEl.addEventListener('scroll', () => {
    if (Math.abs(scrollEl.scrollTop - lastWrite) < 1) return
    if (distanceFromBottom(scrollEl) <= BOTTOM_SLACK_PX) {
      follow(true)
      updateJump()
    } else {
      yieldToReader()
    }
  }, { passive: true })

  function measureAfterRender(anchor: () => number | null) {
    const target = following ? followTarget({
      scrollHeight: scrollEl.scrollHeight,
      clientHeight: scrollEl.clientHeight,
      anchorTop: anchorSpent ? null : anchor(),
    }) : null
    const atBottom = distanceFromBottom(scrollEl) <= BOTTOM_SLACK_PX
    return () => {
      if (target && following) {
        write(target.scrollTop)
        if (target.capped) {
          follow(false)
          anchorSpent = true
        }
      }
      jumpButton.hidden = following || (target ? !target.capped : atBottom)
    }
  }

  return {
    measureAfterRender,
    afterRender({ anchorTop }: { anchorTop: number | null }) { measureAfterRender(() => anchorTop)() },
    /** A new question: follow again, anchored on it. */
    resetForPrompt() {
      follow(true)
      anchorSpent = false
    },
    jumpToLatest() {
      follow(true)
      anchorSpent = true
      write(scrollEl.scrollHeight)
      updateJump()
    },
    /** Content changed size without a re-render (web fonts, wrapping): stay on the bottom if that is where we are following. */
    onContentResize() {
      if (!following || !anchorSpent) return
      write(scrollEl.scrollHeight)
      updateJump()
    },
    isFollowing: () => following,
  }
}

/**
 * Where the drawer list should sit after a re-render: on the latest step when the trace opens,
 * stuck to the bottom if the reader was there, otherwise exactly where they left it.
 */
export function drawerScrollPlan(prev: ScrollSnapshot | null, tab: string) {
  if (!prev || prev.tab !== tab) return { stickToBottom: tab === 'trace', top: 0 }
  return { stickToBottom: prev.atBottom, top: prev.top }
}

/** Where a scroll container was, and on which tab, before it was replaced. */
type ScrollSnapshot = { tab: string, top: number, atBottom: boolean }

/** Snapshot of a scroll container before it is replaced. */
export function scrollSnapshot(el: Element | null, tab: string): ScrollSnapshot | null {
  return el ? { tab, top: el.scrollTop, atBottom: distanceFromBottom(el) <= BOTTOM_SLACK_PX } : null
}
