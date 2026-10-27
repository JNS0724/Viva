import { capture, run, until, UI_WAIT_MS, wait, type Expect, type SmokeWindow } from './smoke-kit.ts'

/**
 * The dock (view/task-dock.ts) and the column's width (view/column-resize.ts) in the memory smoke run, once some
 * tasks have ended: in a wide window the dock floats beside the column, clear of the input; the column's edge,
 * dragged, makes it wider, and a double-click puts it back; with the drawer open there is no room, so the dock
 * folds to its tag by itself.
 */
const WIDE: readonly [number, number] = [1600, 1000]
const DRAG_PX = 120

/** A window that can be resized: the app's own (BrowserWindow), as the memory run is given. */
type Sized = SmokeWindow & { getSize(): number[], setSize(width: number, height: number): void }
const sized = (win: SmokeWindow): win is Sized => typeof (win as Partial<Sized>).setSize === 'function'

const LAYOUT = `(() => {
  const box = (el) => { const r = el?.getBoundingClientRect(); return r && r.width ? { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) } : null }
  const dock = document.getElementById('task-dock')
  return {
    folded: dock.dataset.collapsed, hidden: dock.hidden, tiles: dock.querySelectorAll('.dock-tile').length,
    tag: dock.querySelector('.dock-tag')?.textContent ?? null,
    dock: box(dock), composer: box(document.getElementById('composer')),
  }
})()`

/** Page code: a drag on the right grip by `dx` pixels, as the pointer would make it. */
const drag = (dx: number) => `(() => {
  const grip = document.getElementById('col-grip-right')
  const r = grip.getBoundingClientRect()
  const x = r.left + r.width / 2, y = r.top + r.height / 2
  const at = (type, cx) => grip.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, clientX: cx, clientY: y }))
  at('pointerdown', x); at('pointermove', x + ${dx}); at('pointerup', x + ${dx})
})()`

const drawerOpen = `document.getElementById('drawer').dataset.open === 'true'`

export async function dockSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  if (!sized(win)) return expect(false, 'the dock steps need the app window to resize')
  const [width, height] = win.getSize()
  if (await run(win, drawerOpen)) await run(win, `document.getElementById('toggle-drawer').click()`)
  win.setSize(...WIDE)
  try {
    await wait(UI_WAIT_MS)
    // Unfolded, if an earlier step or launch left it folded.
    await run(win, `document.querySelector('#task-dock .dock-tag')?.click()`)
    const wide = await until(win, `(() => { const seen = ${LAYOUT}; return seen.tiles > 0 && seen })()`, 'the dock unfolded in a wide window')
    expect(wide.dock && wide.composer && wide.dock.left >= wide.composer.right, 'the dock should float beside the column, clear of the input', wide)
    await capture(win, outDir, 'tasks-dock')

    const before = wide.composer.width
    await run(win, drag(DRAG_PX))
    await wait(UI_WAIT_MS)
    const wider = await run(win, LAYOUT)
    expect(wider.composer.width >= before + DRAG_PX, 'dragging the column\'s edge should make it wider', { before, after: wider.composer.width })
    await capture(win, outDir, 'column-wide')
    await run(win, `document.getElementById('col-grip-right').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await wait(UI_WAIT_MS)
    const back = await run(win, LAYOUT)
    expect(back.composer.width === before, 'a double-click should put the column back', { before, after: back.composer.width })

    await run(win, `document.getElementById('toggle-drawer').click()`)
    const folded = await until(win, `(() => { const seen = ${LAYOUT}; return seen.folded === 'true' && seen })()`, 'the dock folding with the drawer open', 5_000)
      .catch(async () => run(win, LAYOUT))
    expect(folded.folded === 'true' && folded.tiles === 0 && folded.tag, 'with no room beside the column the dock should fold to its tag', folded)
    await run(win, `document.getElementById('toggle-drawer').click()`)
  } finally {
    win.setSize(width, height)
    await wait(UI_WAIT_MS)
  }
}
