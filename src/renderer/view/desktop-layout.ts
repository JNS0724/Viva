import { queueLayout } from './reconcile.ts'

/** Native placement owns the avatar centre; content avoids host edges without moving that centre. */
export function placeDesktopIsland(el: HTMLElement, stage: HTMLElement, placement: {
  anchor: { x: number, y: number }, side: 'left' | 'right', panelWidth: number,
}, painted: () => void = () => {}) {
  queueLayout(stage, () => {
    const { anchor, side, panelWidth: width } = placement
    const surface = el.querySelector<HTMLElement>('.isl-surface')!
    const peek = el.querySelector<HTMLElement>('.isl-peek')!
    const height = stage.clientHeight
    const top = (size: number) => Math.max(0, Math.min(anchor.y - 40, height - size - 10)) - (anchor.y - 40)
    const surfaceTop = top(surface.offsetHeight), peekTop = top(peek.offsetHeight)
    return () => {
      el.style.left = `${anchor.x - 40}px`; el.style.top = `${anchor.y - 40}px`
      surface.style.width = `${width}px`; peek.style.width = `${Math.min(320, width)}px`
      surface.style.left = `${side === 'left' ? -12 - width : 92}px`
      peek.style.left = `${side === 'left' ? -12 - Math.min(320, width) : 92}px`
      surface.style.top = `${surfaceTop}px`; peek.style.top = `${peekTop}px`
      queueLayout(el, () => { painted() })
    }
  })
}
