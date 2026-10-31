import { capture, run, until, UI_WAIT_MS, wait, type Expect, type SmokeWindow } from './smoke-kit.ts'

/**
 * The dock (view/task-dock.ts), the turn rail beside it and the column's width (view/column-resize.ts) in the
 * memory smoke run. Once some tasks have ended: in a wide window the dock is a panel right of the column and the
 * rail is on the left; past three rows one line says how many more; a rail mark's tip opens over the text; the
 * column's edge, dragged, makes it wider, never into the rail's lane, and a double-click puts it back; with the
 * drawer open there is no room and, nothing waiting on the user, the dock steps away. Then, with a task waiting
 * (dockPendingSteps): its row is tinted, and pressed by the column the dock keeps a clear tag that says so.
 */
const WIDE: readonly [number, number] = [1600, 1000]
/** Too narrow for the dock beside the default column. */
const NARROW: readonly [number, number] = [1100, 800]
const DRAG_PX = 120
/** Far past the widest the column may be. */
const DRAG_MAX_PX = 2000
/** Background tasks added, as many as needed, so the dock has more than the three rows it shows. */
const EXTRA_TASKS = ['帮我核对一下这个月的发票', '帮我整理一下周会纪要', '帮我把季度目标列成清单'] as const
const SETTLE_MS = 30_000

/** A window that can be resized: the app's own (BrowserWindow), as the memory run is given. */
type Sized = SmokeWindow & { getSize(): number[], setSize(width: number, height: number): void }
const sized = (win: SmokeWindow): win is Sized => typeof (win as Partial<Sized>).setSize === 'function'

const LAYOUT = `(() => {
  const box = (el) => { const r = el?.getBoundingClientRect(); return r && r.width ? { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) } : null }
  const dock = document.getElementById('task-dock')
  const main = document.querySelector('.main')
  const rail = document.getElementById('turn-rail')
  const tag = dock.querySelector('.dock-tag')
  return {
    folded: dock.dataset.collapsed, hidden: dock.hidden, tiles: dock.querySelectorAll('.dock-tile').length,
    tag: tag?.textContent ?? null, tone: tag?.dataset.tone ?? null, more: dock.querySelector('.dock-more')?.textContent ?? null,
    dock: box(dock), composer: box(document.getElementById('composer')), main: box(main),
    rail: rail.hidden ? null : box(rail), lane: parseFloat(getComputedStyle(main).getPropertyValue('--rail-lane')),
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

/** More tasks than the dock shows: three rows and a line for the rest, right of the column, the rail on the left. */
async function manySteps(win: Sized, outDir: string, expect: Expect, start: (text: string) => Promise<unknown>) {
  for (const text of EXTRA_TASKS) {
    if (await run(win, `Boolean(document.querySelector('#task-dock .dock-more'))`)) break
    await start(text)
    await wait(UI_WAIT_MS)
  }
  // The ones added answer at once; settled (every task card in the conversation, not only the rows shown), the
  // screenshot shows them as they stay.
  await until(win, `!document.querySelector('.task-card[data-status="running"]')`, 'every task added settling', SETTLE_MS)
  const many = await until(win, `(() => { const seen = ${LAYOUT}; return seen.more && seen })()`, 'the dock with more tasks than it shows')
  expect(many.tiles === 3 && /^还有 \d+ 件 · 全部 →$/.test(many.more), 'past three rows the dock should say how many more', many)
  expect(many.rail && many.rail.right <= many.composer.left && many.dock.left >= many.composer.right,
    'the rail should be left of the column and the dock right of it', many)
  await capture(win, outDir, 'dock-many')

  // A rail mark pointed at: its tip opens rightwards, over the text.
  const mark = await run(win, MIDDLE_MARK)
  expect(mark, 'the turn rail should be there', mark)
  if (!mark) return
  win.webContents.sendInputEvent({ type: 'mouseMove', x: mark.x, y: mark.y })
  await wait(UI_WAIT_MS)
  expect(await run(win, tipShown), 'a rail mark pointed at should show its tip', mark)
  await capture(win, outDir, 'rail-left-tip')
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(WIDE[0] / 2), y: 200 })
}

/** The column dragged as wide as it goes: it stops at the rail's lane; the dock, without room, steps away. */
async function widestSteps(win: Sized, outDir: string, expect: Expect) {
  await run(win, drag(DRAG_MAX_PX))
  await wait(UI_WAIT_MS)
  const widest = await run(win, LAYOUT)
  const overflow = await run(win, `(() => { const scroll = document.getElementById('scroll'); const wide = [...scroll.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > scroll.getBoundingClientRect().right + 1).slice(0, 5).map((el) => el.className || el.tagName); return { scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth, wide } })()`)
  expect(overflow.scrollWidth <= overflow.clientWidth, 'at its widest the column should not scroll sideways', overflow)
  const railClear = !widest.rail || widest.rail.right <= widest.composer.left
  expect(widest.composer.left >= widest.main.left + widest.lane && railClear, 'at its widest the column should leave the rail\'s lane free', widest)
  expect(widest.hidden, 'pressed by the column with nothing waiting, the dock should step away', widest)
  await capture(win, outDir, 'column-max')
  await run(win, resetColumn)
  await wait(UI_WAIT_MS)
}

export async function dockSteps(win: SmokeWindow, outDir: string, expect: Expect, start: (text: string) => Promise<unknown>) {
  if (!sized(win)) return expect(false, 'the dock steps need the app window to resize')
  const [width, height] = win.getSize()
  if (await run(win, drawerOpen)) await run(win, toggleDrawer)
  win.setSize(...WIDE)
  try {
    await wait(UI_WAIT_MS)
    // Unfolded, if an earlier step or launch left it folded.
    await run(win, `document.querySelector('#task-dock .dock-tag')?.click()`)
    const wide = await until(win, `(() => { const seen = ${LAYOUT}; return seen.tiles > 0 && seen })()`, 'the dock unfolded in a wide window')
    expect(wide.dock && wide.composer && wide.dock.left >= wide.composer.right, 'the dock should float beside the column, clear of the input', wide)
    await capture(win, outDir, 'tasks-dock')
    await manySteps(win, outDir, expect, start)

    const before = wide.composer.width
    await run(win, drag(DRAG_PX))
    await wait(UI_WAIT_MS)
    const wider = await run(win, LAYOUT)
    expect(wider.composer.width >= before + DRAG_PX, 'dragging the column\'s edge should make it wider', { before, after: wider.composer.width })
    await capture(win, outDir, 'column-wide')
    await run(win, resetColumn)
    await wait(UI_WAIT_MS)
    const back = await run(win, LAYOUT)
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

    // The drawer open leaves no room; nothing waits on the user, so the dock steps away.
    await run(win, toggleDrawer)
    const away = await until(win, `(() => { const seen = ${LAYOUT}; return seen.hidden && seen })()`, 'the dock stepping away with the drawer open', 5_000)
      .catch(async () => run(win, LAYOUT))
    expect(away.hidden, 'with no room and nothing waiting the dock should step away', away)
    await run(win, toggleDrawer)
  } finally {
    win.setSize(width, height)
    await wait(UI_WAIT_MS)
  }
}

/**
 * With a task waiting on the user: its row tinted in the wide window; pressed by the column (the drawer open, a
 * narrow window), a clear tag that says so; clicked, the dock peeks above the input; typing puts it away.
 */
export async function dockPendingSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  if (!sized(win)) return expect(false, 'the dock steps need the app window to resize')
  const [width, height] = win.getSize()
  win.setSize(...WIDE)
  try {
    await wait(UI_WAIT_MS)
    await run(win, `document.querySelector('#task-dock .dock-tag')?.click()`)
    const wide = await until(win, `(() => { const seen = ${LAYOUT}; return seen.tiles > 0 && document.querySelector('#task-dock .dock-tile[data-status="waiting"]') && seen })()`,
      'the waiting task in the dock')
    expect(wide.tiles > 0, 'the waiting task should be in the dock', wide)
    await capture(win, outDir, 'dock-waiting')

    // Folded by the user first: pressed by the column, its tag still opens it (a peek outranks the user's fold).
    await run(win, `document.querySelector('#task-dock .dock-fold').click()`)
    await wait(UI_WAIT_MS)
    expect((await run(win, LAYOUT)).folded === 'true', 'the dock\'s – should fold it')
    await run(win, toggleDrawer)
    const pending = await until(win, `(() => { const seen = ${LAYOUT}; return seen.folded === 'true' && !seen.hidden && seen })()`, 'the pending tag with the drawer open', 5_000)
      .catch(async () => run(win, LAYOUT))
    expect(pending.tone === 'waits' && /等你处理/.test(pending.tag ?? ''), 'pressed by the column, a task waiting should keep a clear tag', pending)
    await capture(win, outDir, 'dock-pending')
    // Peeked at, it opens above the input, not over it; typing puts it away again.
    await run(win, `document.querySelector('#task-dock .dock-tag').click()`)
    await wait(UI_WAIT_MS)
    const peek = await run(win, `(() => ({
      tiles: document.querySelectorAll('#task-dock .dock-tile').length,
      dockBottom: Math.round(document.getElementById('task-dock').getBoundingClientRect().bottom),
      composerTop: Math.round(document.getElementById('composer').getBoundingClientRect().top),
    }))()`)
    expect(peek.tiles > 0 && peek.dockBottom <= peek.composerTop, 'peeked at, the dock should sit above the input', peek)
    await capture(win, outDir, 'tasks-dock-peek')
    await run(win, `(() => { const input = document.getElementById('composer-input'); input.value = '在'; input.dispatchEvent(new Event('input', { bubbles: true })); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await wait(UI_WAIT_MS)
    expect((await run(win, LAYOUT)).folded === 'true', 'typing should put the peeked dock away')
    await run(win, toggleDrawer)
    // Room again: the user's fold is kept until the tag unfolds it.
    await wait(UI_WAIT_MS)
    expect((await run(win, LAYOUT)).folded === 'true', 'with room again the user\'s fold should be kept')
    await run(win, `document.querySelector('#task-dock .dock-tag').click()`)
    await until(win, `(${LAYOUT}).tiles > 0`, 'the dock unfolded again by its tag', 5_000)

    // A narrow window: the same clear tag in the corner, the conversation first.
    win.setSize(...NARROW)
    const narrow = await until(win, `(() => { const seen = ${LAYOUT}; return seen.folded === 'true' && !seen.hidden && seen })()`, 'the pending tag in a narrow window', 5_000)
      .catch(async () => run(win, LAYOUT))
    expect(narrow.tone === 'waits', 'in a narrow window a task waiting should keep its tag', narrow)
    await wait(UI_WAIT_MS)
    await capture(win, outDir, 'dock-narrow')
  } finally {
    win.setSize(width, height)
    await wait(UI_WAIT_MS)
  }
}
