import { scheduleFrame } from './frame.ts'

/** Keep unchanged nodes attached: replacing a whole conversation invalidates every message's layout. */
export function reconcileChildren(parent: HTMLElement, children: readonly (Node | string)[]): boolean {
  const nodes = children.map(child => typeof child === 'string' ? document.createTextNode(child) : child)
  const wanted = new Set(nodes)
  let cursor = parent.firstChild
  let changed = false
  while (cursor) {
    const next = cursor.nextSibling
    if (!wanted.has(cursor)) { parent.removeChild(cursor); changed = true }
    cursor = next
  }
  cursor = parent.firstChild
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextSibling
    else {
      parent.insertBefore(node, cursor)
      changed = true
    }
  }
  return changed
}

/** One layout read/write pass per frame, after all the regions have finished writing DOM. */
export function createLayoutQueue(frame: (run: () => void) => unknown = scheduleFrame) {
  const pending = new Map<object, () => void | (() => void)>()
  let scheduled = false
  return (key: object, run: () => void | (() => void)) => {
    pending.set(key, run)
    if (scheduled) return
    scheduled = true
    frame(() => {
      scheduled = false
      const batch = [...pending.values()]
      pending.clear()
      const writes = batch.map(measure => measure())
      writes.forEach(write => { if (typeof write === 'function') write() })
    })
  }
}

/** All regions measure before any of them write geometry. */
export const queueLayout = createLayoutQueue()
