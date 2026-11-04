import { capture, run, settled, wait, UI_WAIT_MS, type Expect, type SmokeWindow } from './smoke-kit.ts'

/**
 * The turn rail and the column's width (view/column-resize.ts) in the memory smoke run, in a wide window: the rail
 * is left of the column and a mark's tip opens over the text; the column's edge, dragged, makes it wider, never
 * into the rail's lane, and a double-click (or Home on a grip) puts it back; an arrow key on a grip widens it.
 */
const WIDE: readonly [number, number] = [1600, 1000]
const DRAG_PX = 120
/** Far past the widest the column may be. */
const DRAG_MAX_PX = 2000
/** The lane the column leaves free at the main area's left for the rail (view/column-resize.ts COLUMN.margin). */
const RAIL_LANE_PX = 40

/** A window that can be resized: the app's own (BrowserWindow), as the memory run is given. */
type Sized = SmokeWindow & { getSize(): Promise<[number, number]>, setSize(width: number, height: number): Promise<void> }
const sized = (win: SmokeWindow): win is Sized => typeof (win as Partial<Sized>).setSize === 'function'

const LAYOUT = `(() => {
  const box = (el) => { const r = el?.getBoundingClientRect(); return r && r.width ? { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) } : null }
  const main = document.querySelector('.main')
  const rail = document.getElementById('turn-rail')
  return {
    composer: box(document.getElementById('composer')), main: box(main),
    rail: rail.hidden ? null : box(rail),
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
const resetColumn = `document.getElementById('col-grip-right').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`

const drawerOpen = `document.getElementById('drawer').dataset.open === 'true'`
const toggleDrawer = `document.getElementById('toggle-drawer').click()`

/** The rail's middle mark: where it is, to point at. */
const MIDDLE_MARK = `(() => {
  const marks = [...document.querySelectorAll('#turn-rail .turn-mark')]
  const box = marks[Math.floor(marks.length / 2)]?.getBoundingClientRect()
  return box ? { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) } : null
})()`
const tipShown = `(() => { const mark = [...document.querySelectorAll('#turn-rail .turn-mark')].find((el) => el.matches(':hover')); return Boolean(mark) && getComputedStyle(mark, '::after').opacity === '1' })()`

/** The rail left of the column; a mark pointed at opens its tip rightwards, over the text. */
async function railSteps(win: Sized, outDir: string, expect: Expect) {
  const layout = await run(win, LAYOUT)
  expect(layout.rail && layout.rail.right <= layout.composer.left, 'the rail should be left of the column', layout)
  const mark = await run(win, MIDDLE_MARK)
  expect(mark, 'the turn rail should be there', mark)
  if (!mark) return
  await win.webContents.sendInputEvent({ type: 'mouseMove', x: mark.x, y: mark.y })
  await wait(UI_WAIT_MS)
  expect(await run(win, tipShown), 'a rail mark pointed at should show its tip', mark)
  await capture(win, outDir, 'rail-left-tip')
  await win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(WIDE[0] / 2), y: 200 })
}

/** The column dragged as wide as it goes: it stops at the rail's lane, and nothing scrolls sideways. */
async function widestSteps(win: Sized, outDir: string, expect: Expect) {
  await run(win, drag(DRAG_MAX_PX))
  await wait(UI_WAIT_MS)
  const widest = await run(win, LAYOUT)
  const overflow = await run(win, `(() => { const scroll = document.getElementById('scroll'); const wide = [...scroll.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > scroll.getBoundingClientRect().right + 1).slice(0, 5).map((el) => el.className || el.tagName); return { scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth, wide } })()`)
  expect(overflow.scrollWidth <= overflow.clientWidth, 'at its widest the column should not scroll sideways', overflow)
  const railClear = !widest.rail || widest.rail.right <= widest.composer.left
  expect(widest.composer.left >= widest.main.left + RAIL_LANE_PX && railClear, 'at its widest the column should leave the rail\'s lane free', widest)
  await capture(win, outDir, 'column-max')
  await run(win, resetColumn)
  await wait(UI_WAIT_MS)
}

export async function columnSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  if (!sized(win)) return expect(false, 'the column steps need the app window to resize')
  const [width, height] = (await win.getSize())
  if (await run(win, drawerOpen)) await run(win, toggleDrawer)
  await win.setSize(...WIDE)
  try {
    await wait(UI_WAIT_MS)
    await railSteps(win, outDir, expect)
    const before = (await run(win, LAYOUT)).composer.width
    await run(win, drag(DRAG_PX))
    const wider = await settled<{ composer: { width: number } }>(win, LAYOUT, (seen) => seen.composer.width >= before + DRAG_PX)
    expect(wider.composer.width >= before + DRAG_PX, 'dragging the column\'s edge should make it wider', { before, after: wider.composer.width })
    await capture(win, outDir, 'column-wide')
    await run(win, resetColumn)
    const back = await settled<{ composer: { width: number } }>(win, LAYOUT, (seen) => seen.composer.width === before)
    expect(back.composer.width === before, 'a double-click should put the column back', { before, after: back.composer.width })
    await widestSteps(win, outDir, expect)

    // The keyboard reaches the grips too: an arrow outwards widens the column, Home puts it back.
    await run(win, `(() => { const grip = document.getElementById('col-grip-right'); grip.focus(); grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })()`)
    await wait(UI_WAIT_MS)
    const keyed = (await run(win, LAYOUT)).composer.width
    await run(win, `document.getElementById('col-grip-right').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))`)
    await wait(UI_WAIT_MS)
    const homed = (await run(win, LAYOUT)).composer.width
    expect(keyed > before && homed === before, 'an arrow key should widen the column and Home put it back', { before, keyed, homed })
  } finally {
    await win.setSize(width, height)
    await wait(UI_WAIT_MS)
  }
}
