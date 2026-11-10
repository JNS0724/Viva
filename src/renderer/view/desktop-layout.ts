import { queueLayout } from './reconcile.ts'

/** Native placement owns the avatar centre; content avoids host edges without moving that centre. */
export function placeDesktopIsland(el: HTMLElement, stage: HTMLElement, placement: {
  anchor: { x: number, y: number }, side: 'left' | 'right', panelWidth: number, viewport?: { top: number, bottom: number },
}, painted: () => void = () => {}) {
  queueLayout(stage, () => {
    const { anchor, side, panelWidth: width } = placement
    const surface = el.querySelector<HTMLElement>('.isl-surface')!
    const peek = el.querySelector<HTMLElement>('.isl-peek')!
    const height = stage.clientHeight
    const minimum = Math.max(0, placement.viewport?.top ?? 0)
    const maximum = Math.min(height, placement.viewport?.bottom ?? height)
    const top = (size: number) => Math.max(minimum, Math.min(anchor.y - 40, maximum - size - 10)) - (anchor.y - 40)
    const surfaceTop = top(surface.offsetHeight), peekTop = top(peek.offsetHeight)
    return () => {
      el.style.left = `${anchor.x - 40}px`; el.style.top = `${anchor.y - 40}px`
      surface.style.width = `${width}px`
      surface.style.left = `${side === 'left' ? -12 - width : 92}px`
      // The strip is as long as what it says, up to its widest; on her left it ends beside her, however long.
      peek.style.width = ''
      peek.style.maxWidth = `${Math.min(320, width)}px`
      peek.style.left = side === 'left' ? 'auto' : '92px'
      peek.style.right = side === 'left' ? '92px' : 'auto'
      surface.style.top = `${surfaceTop}px`; peek.style.top = `${peekTop}px`
      queueLayout(el, () => { painted() })
    }
  })
}
