import { queueLayout } from './reconcile.ts'

/** Native placement owns the avatar centre; content avoids host edges without moving that centre. */
export function placeDesktopIsland(el: HTMLElement, stage: HTMLElement, placement: {
  anchor: { x: number, y: number }, side: 'left' | 'right', panelWidth: number, viewport?: { top: number, bottom: number },
}, painted: () => void = () => {}) {
  queueLayout(stage, () => {
    const { anchor, side, panelWidth } = placement
    const surface = el.querySelector<HTMLElement>('.isl-surface')!
    const peek = el.querySelector<HTMLElement>('.isl-peek')!
    const compactWidth = `min(var(--desk-peek-width), ${panelWidth}px)`
    const width = el.dataset.form === 'switching' ? compactWidth : `${panelWidth}px`
    const height = stage.clientHeight
    const minimum = Math.max(0, placement.viewport?.top ?? 0)
    const maximum = Math.min(height, placement.viewport?.bottom ?? height)
    const top = (size: number) => Math.max(minimum, Math.min(anchor.y - 40, maximum - size - 10)) - (anchor.y - 40)
    const surfaceTop = top(surface.offsetHeight), peekTop = top(peek.offsetHeight)
    return () => {
      el.style.left = `${anchor.x - 40}px`; el.style.top = `${anchor.y - 40}px`
      surface.style.width = width
      surface.style.left = side === 'left' ? `calc(-1 * var(--desk-neighbor-gap) - ${width})` : '92px'
      // The strip is as long as what it says, up to its widest; on her left it ends beside her, however long.
      peek.style.width = ''
      peek.style.maxWidth = compactWidth
      peek.style.left = side === 'left' ? 'auto' : '92px'
      peek.style.right = side === 'left' ? '92px' : 'auto'
      surface.style.top = `${surfaceTop}px`; peek.style.top = `${peekTop}px`
      queueLayout(el, () => { painted() })
    }
  })
}
