import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDeskIsland, DESK_TIMES, LAYOUT_READY_MS, deskForm } from '../src/shell/desk-island.ts'
import type { BrowserWindow, Display, Rectangle, WebContents } from 'electron'
import type { Places } from '../src/shell/desk-place.ts'
import { DESK_SIZE, DRAG_SIZE, FIXED_DESK_HOST, dragBounds, deskLayout, homePoint } from '../src/shell/desk-place.ts'
import { deskMenuTemplate } from '../src/shell/desk-menu.ts'
import { describeDropped, MISSING, NOT_A_FILE } from '../src/shell/island-files.ts'
import { ASK_LIMITS, checkAsk, checkDroppedPaths, checkIslandAction, checkIslandView } from '../src/shell/island-ipc.ts'

const view = (form: string, extra: Record<string, unknown> = {}) => ({ form, tone: 'idle', mood: 'idle', label: 'x', recent: [], ...extra })
const away = { enabled: true, away: true, sinceDone: 0 }

test('the desktop island shows once the window is closed to the tray: what goes on, else just the cat', () => {
  for (const form of ['working', 'waiting', 'asking', 'error']) assert.equal(deskForm({ ...away, view: view(form) }), form)
  for (const form of ['idle', 'pending']) assert.equal(deskForm({ ...away, view: view(form) }), 'mini')
  assert.equal(deskForm({ ...away, view: null }), 'mini')
  assert.equal(deskForm({ ...away, away: false, view: view('working') }), null, 'the open window has its own island, covered or not')
  assert.equal(deskForm({ ...away, enabled: false, view: view('waiting') }), null)
})

test('after a turn the island says done, then rests as the cat; called up while switched off, it then goes', () => {
  const done = view('done')
  assert.equal(deskForm({ ...away, view: done, sinceDone: 0 }), 'done')
  assert.equal(deskForm({ ...away, view: done, sinceDone: DESK_TIMES.done }), 'mini')
  assert.equal(deskForm({ ...away, view: done, sinceDone: DESK_TIMES.done + DESK_TIMES.mini }), 'mini')
  const summoned = { ...away, enabled: false, summoned: true, view: done }
  assert.equal(deskForm({ ...summoned, sinceDone: DESK_TIMES.done }), 'mini')
  assert.equal(deskForm({ ...summoned, sinceDone: DESK_TIMES.done + DESK_TIMES.mini }), null)
})

test('the input shows whenever it is open, unless the window is in front with its own', () => {
  assert.equal(deskForm({ ...away, enabled: false, view: view('idle'), input: true }), 'input', 'the island switched off, too')
  assert.equal(deskForm({ ...away, away: false, view: view('idle'), input: true }), null)
})

test('only the actions the island offers get through, with their ids', () => {
  assert.deepEqual(checkIslandAction({ kind: 'permission', requestId: 'r1', optionId: 'allow-once', extra: 'x' }), { kind: 'permission', requestId: 'r1', optionId: 'allow-once' })
  assert.deepEqual(checkIslandAction({ kind: 'answer', questionId: 'q', id: 'city', label: '上海' }), { kind: 'answer', questionId: 'q', id: 'city', label: '上海' })
  assert.deepEqual(checkIslandAction({ kind: 'skip', questionId: 'q', id: 'x' }), { kind: 'skip', questionId: 'q' })
  assert.equal(checkIslandAction({ kind: 'skip' }), null)
  assert.deepEqual(checkIslandAction({ kind: 'cancel' }), { kind: 'cancel' })
  assert.deepEqual(checkIslandAction({ kind: 'open' }), { kind: 'open' })
  assert.deepEqual(checkIslandAction({ kind: 'rect', x: 20, y: 10, width: 300, height: 48, z: 1 }), { kind: 'rect', x: 20, y: 10, width: 300, height: 48 })
  assert.equal(checkIslandAction({ kind: 'rect', x: 20, y: 10, width: Infinity, height: 48 }), null)
  assert.deepEqual(checkIslandAction({ kind: 'drag', phase: 'start' }), { kind: 'drag', phase: 'start' })
  assert.equal(checkIslandAction({ kind: 'drag', phase: 'fling' }), null)
  assert.deepEqual([checkIslandAction({ kind: 'input' }), checkIslandAction({ kind: 'dismiss' })], [{ kind: 'input' }, { kind: 'dismiss' }])
  assert.equal(checkIslandAction({ kind: 'prompt', text: 'rm -rf /' }), null, 'a question goes only through its own checked channel (checkAsk)')
  assert.equal(checkIslandAction({ kind: 'pointer', inside: true }), null)
  assert.equal(checkIslandAction({ kind: 'permission', requestId: 5 }), null)
  assert.equal(checkIslandAction({ kind: 'answer', questionId: 'q', id: 'a', label: 'x'.repeat(500) }), null)
  assert.equal(checkIslandAction(null), null)
  // A task in the island's 后台 list: opened in the window's drawer, or stopped.
  assert.deepEqual(checkIslandAction({ kind: 'task', taskId: 's1', x: 1 }), { kind: 'task', taskId: 's1' })
  assert.deepEqual(checkIslandAction({ kind: 'stop-task', taskId: 's1' }), { kind: 'stop-task', taskId: 's1' })
  assert.equal(checkIslandAction({ kind: 'stop-task', taskId: 'x'.repeat(500) }), null)
  assert.equal(checkIslandAction({ kind: 'task' }), null)
})

test('a view from the window must look like one and stay small', () => {
  const ok = view('working', { action: '读取网页', startedAt: 1, steps: 2 })
  assert.deepEqual(checkIslandView(ok), ok)
  assert.equal(checkIslandView(view('exploded')), null)
  assert.equal(checkIslandView({ form: 'working' }), null, 'needs its label and steps')
  assert.equal(checkIslandView(view('working', { detail: 'x'.repeat(40_000) })), null)
  assert.equal(checkIslandView('working'), null)
})

test('a question from the island: text within bounds, and only paths for files', () => {
  assert.deepEqual(checkAsk({ text: '  总结 ', files: ['/a/b.docx'], extra: 1 }), { text: '总结', files: ['/a/b.docx'], images: [] })
  assert.deepEqual(checkAsk({ text: '在吗' }), { text: '在吗', files: [], images: [] })
  assert.deepEqual(checkAsk({ text: '', files: ['/a/note.txt'] }), { text: '', files: ['/a/note.txt'], images: [] })
  assert.equal(checkAsk({ text: '   ' }), null)
  // A pasted picture: only its name in the pictures folder; with one, the words may be left out.
  const pic = { id: `${'f'.repeat(64)}.png` }
  assert.deepEqual(checkAsk({ text: '', images: [{ ...pic, path: '/etc' }] }), { text: '', files: [], images: [pic] })
  assert.equal(checkAsk({ text: '看看', images: [{ id: '/etc/passwd' }] }), null)
  assert.equal(checkAsk({ images: [pic] }), null)
  assert.equal(checkAsk({ text: 'x'.repeat(ASK_LIMITS.chars + 1) }), null)
  assert.equal(checkAsk({ text: '总结', files: '/a/b.docx' }), null)
  assert.equal(checkAsk({ text: '总结', files: [42] }), null)
  assert.equal(checkDroppedPaths(Array.from({ length: ASK_LIMITS.files + 1 }, (_, i) => `/f${i}`)), null)
  assert.equal(checkDroppedPaths([]), null)
})

test('dropped files are described; a folder or a missing file is refused with a reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-drop-'))
  const file = path.join(dir, 'Q3 周报.docx')
  fs.writeFileSync(file, 'x'.repeat(2048))
  assert.deepEqual(describeDropped([file]), { files: [{ path: file, name: 'Q3 周报.docx', size: 2048 }] })
  assert.deepEqual(describeDropped([file, dir]), { error: NOT_A_FILE })
  assert.deepEqual(describeDropped([path.join(dir, 'gone.txt')]), { error: MISSING })
  assert.deepEqual(describeDropped(['relative.txt']), { error: MISSING })
})

/** Stand-ins for Electron's window and screen, recording what the island asks of them. */
function fakes({ cursor = { x: 0, y: 0 } } = {}) {
  const display = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } }
  const windows: FakeWindow[] = []
  class FakeWindow {
    visible: boolean
    focusable: boolean
    focused: boolean
    bounds: Rectangle
    ignoring: boolean[]
    sent: Array<[string, { form: string, dragging: boolean, dir: string, coach: boolean, layoutVersion: number, anchor: { x: number, y: number }, viewport: { top: number, bottom: number } }]>
    handlers: Record<string, () => void>
    webContents: { send: (channel: string, payload: FakeWindow['sent'][number][1]) => void, on: (event: string, callback: () => void) => void, setWindowOpenHandler: () => void }
    onTop = false
    destroyed = false
    shape: Rectangle[] = []
    shapeCalls = 0
    boundsHistory: Rectangle[] = []
    constructor(options: { focusable?: boolean, width: number, height: number }) {
      this.visible = false
      this.focusable = Boolean(options.focusable)
      this.focused = false
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height }
      this.ignoring = []
      this.sent = []
      this.handlers = {}
      this.webContents = {
        send: (channel, payload) => this.sent.push([channel, payload]),
        on: (event, callback) => { this.handlers[event] = callback },
        setWindowOpenHandler() {},
      }
      windows.push(this)
    }
    setAlwaysOnTop(value: boolean) { this.onTop = value }
    isAlwaysOnTop() { return Boolean(this.onTop) }
    setShape(rects: Rectangle[]) { this.shape = rects; this.shapeCalls += 1 }
    setVisibleOnAllWorkspaces() {}
    setContentProtection() {}
    setIgnoreMouseEvents(value: boolean) { this.ignoring.push(value) }
    loadFile() {}
    on(event: string, callback: () => void) { this.handlers[event] = callback }
    isDestroyed() { return Boolean(this.destroyed) }
    destroy() {
      this.destroyed = true
      this.visible = false
      this.handlers.closed?.()
    }
    isVisible() { return this.visible }
    showInactive() { this.visible = true }
    hide() { this.visible = false }
    setBounds(bounds: Rectangle) { this.bounds = bounds; this.boundsHistory.push({ ...bounds }) }
    getBounds() { return this.bounds }
    // As on Windows: changing whether the window takes the keyboard loses its place on top (DeepSeek, 2026-10-26).
    setFocusable(value: boolean) {
      this.focusable = value
      this.onTop = false
    }
    focus() { this.focused = this.focusable; this.onTop = false }
    isFocused() { return this.focused }
    blur() { this.focused = false }
    lastView() { return this.sent.filter(([channel]) => channel === 'island:view').at(-1)![1] }
  }
  const screen = {
    getAllDisplays: () => [display as Display],
    getDisplayMatching: () => display as Display,
    getDisplayNearestPoint: () => display as Display,
    getCursorScreenPoint: () => ({ ...cursor }),
  }
  let saved: Places = { last: null, places: {} }
  const places = { get: () => saved, set: (value: Places) => { saved = value } }
  return { windows, screen, cursor, places, saved: () => saved, BrowserWindow: FakeWindow }
}

function deskIsland(env: ReturnType<typeof fakes>, extra: Partial<Parameters<typeof createDeskIsland>[0]> = {}) {
  const desk = createDeskIsland({
    BrowserWindow: env.BrowserWindow as unknown as typeof BrowserWindow, screen: env.screen, preload: 'p', page: 'q', mainWindow: { getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) },
    enabled: true, places: env.places, ...extra,
  })
  desk.setAway(true)
  return desk
}

test('the menu stop action targets a working foreground conversation while background tasks have their own controls', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const desk = deskIsland(fakes())
  desk.setView(view('working', { target: { working: false } }))
  assert.equal(desk.working(), false)
  desk.setView(view('working', { target: { working: true } }))
  assert.equal(desk.working(), true)
  desk.setView(view('working'))
  assert.equal(desk.working(), true)
  desk.setView(view('done', { target: { working: true } }))
  assert.equal(desk.working(), false)
  desk.destroy()
})

test('an image import retires its hidden window, accepts one matching batch, and recreates the next island', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes()
  const desk = deskIsland(env)
  const first = env.windows[0]
  const sender = first.webContents as unknown as WebContents
  first.handlers['did-finish-load']()
  const ticket = desk.beginImport(sender, 'original')!
  desk.setAway(false)
  assert.deepEqual([first.visible, first.destroyed, desk.owns(sender)], [false, false, false])
  assert.equal(desk.beginImport(sender, 'another'), null, 'retired renderers cannot start imports')
  assert.equal(desk.claimImport(sender, 'other', ticket), false)
  assert.equal(desk.claimImport({} as WebContents, 'original', ticket), false)
  assert.equal(desk.claimImport(sender, 'original', 'missing'), false)
  first.handlers['did-finish-load']()
  first.handlers.focus()
  first.handlers.blur()
  assert.equal(desk.webContents(), null, 'late retired events cannot revive a hidden window')
  desk.setAway(true)
  const second = env.windows[1]
  assert.notEqual(first, second)
  assert.equal(second.visible, true)
  assert.equal(desk.claimImport(sender, 'original', ticket), true)
  assert.equal(first.destroyed, true)
  assert.equal(second.destroyed, false)
  assert.equal(desk.claimImport(sender, 'original', ticket), false, 'a ticket is consumed once')
  assert.equal(desk.owns(second.webContents as unknown as WebContents), true)
  desk.destroy()
})

test('all image import holds release on completion, renderer exit, window close, or application teardown', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  for (const finish of ['end', 'renderer-exit', 'window-close', 'destroy']) {
    const env = fakes()
    const desk = deskIsland(env)
    const first = env.windows[0]
    const sender = first.webContents as unknown as WebContents
    const one = desk.beginImport(sender, 'one')!, two = desk.beginImport(sender, 'two')!
    desk.setAway(false)
    assert.equal(first.destroyed, false)
    if (finish === 'end') {
      assert.equal(desk.endImport(sender, one), 'one')
      assert.equal(first.destroyed, false, 'another in-flight read still owns a hold')
      assert.equal(desk.endImport(sender, two), 'two')
    } else if (finish === 'renderer-exit') first.handlers['render-process-gone']()
    else if (finish === 'window-close') first.destroy()
    else desk.destroy()
    assert.equal(first.destroyed, true, finish)
    assert.equal(desk.claimImport(sender, 'one', one), false, finish)
    assert.equal(desk.endImport(sender, two), null, finish)
    desk.destroy()
  }
})

test('the shortcut opens the input, which takes the keyboard until it is closed', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes()
  const desk = deskIsland(env, { enabled: false })
  assert.equal(desk.openInput(), true)
  const [win] = env.windows
  win.handlers['did-finish-load']()
  assert.deepEqual([win.visible, win.focused, win.lastView().form], [true, true, 'input'], 'shown and focused, though switched off')
  desk.setView(view('working'))
  desk.closeInput({ sent: true })
  assert.deepEqual([win.focusable, win.focused, win.visible, win.lastView().form], [process.platform === 'win32', false, true, 'working'], 'what was asked stays up while it runs')
  desk.setView(view('idle'))
  assert.equal(win.visible, false, 'switched off, it goes once that is over')
  desk.destroy()
})

test('the island stays on top of other windows after its input opens and closes', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes()
  const desk = deskIsland(env)
  desk.setView(view('working'))
  const [win] = env.windows
  assert.equal(win.onTop, true, 'shown on top')
  desk.openInput()
  win.handlers['did-finish-load']()
  assert.deepEqual([win.focused, win.onTop], [true, true], 'taking the keyboard, still on top')
  desk.closeInput()
  assert.deepEqual([win.focusable, win.onTop], [process.platform === 'win32', true], 'giving the keyboard back, still on top')
  desk.destroy()
})

test('closed without asking, an island that is switched off goes at once; with the window open there is no input', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes()
  const desk = deskIsland(env, { enabled: false })
  desk.setView(view('working'))
  desk.openInput()
  desk.closeInput()
  assert.equal(env.windows[0].visible, false)
  desk.setAway(false)
  assert.equal(desk.openInput(), false)
  desk.destroy()
})

test('clicks reach only the island, without waiting for the pointer poll on Windows', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes()
  const desk = deskIsland(env)
  desk.setView(view('working'))
  const [win] = env.windows
  Object.assign(env.cursor, { x: win.bounds.x + 300, y: win.bounds.y + 30 })
  desk.setIslandRect({ x: 150, y: 10, width: 300, height: 48 })
  assert.equal(win.ignoring.at(-1), false, 'the pointer is inside the reported region at the current native bounds')
  env.cursor.x = win.bounds.x - 100
  t.mock.timers.tick(60)
  if (process.platform === 'win32') {
    assert.equal(win.ignoring.at(-1), false, 'native region stays interactive even while the cursor is outside')
    assert.deepEqual(win.shape, [{ x: 146, y: 6, width: 308, height: 56 }])
  } else assert.equal(win.ignoring.at(-1), true)
  desk.destroy()
})

test('native topmost loss after activation is repaired without taking focus', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes()
  const desk = deskIsland(env)
  const [win] = env.windows
  win.handlers['did-finish-load']()
  desk.openInput()
  win.onTop = false
  win.handlers.focus()
  t.mock.timers.tick(1)
  assert.equal(win.onTop, true)
  win.focused = false
  win.onTop = false
  win.handlers.blur()
  t.mock.timers.tick(1)
  assert.deepEqual([win.onTop, win.focused, desk.inputOpen()], [true, false, false])
  desk.destroy()
  t.mock.timers.tick(100)
})

test('unchanged island hit regions reuse the native shape and a new window reapplies it', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes()
  const desk = deskIsland(env)
  t.after(() => desk.destroy())
  const [win] = env.windows
  const rect = { x: 20, y: 10, width: 80, height: 80 }
  desk.setIslandRect(rect)
  const calls = win.shapeCalls
  for (let i = 0; i < 60; i++) desk.setIslandRect({ ...rect })
  assert.equal(win.shapeCalls, calls)
  desk.setIslandRect({ ...rect, width: 100 })
  assert.equal(win.shapeCalls, calls + (process.platform === 'win32' ? 1 : 0))
  desk.setAway(false)
  desk.setAway(true)
  const recreated = env.windows.at(-1)!
  desk.setIslandRect(rect)
  assert.equal(recreated.shapeCalls, process.platform === 'win32' ? 1 : 0)
})

test('dragged, the portrait follows the pointer at each frame and is remembered where it is let go', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes()
  const desk = deskIsland(env)
  desk.setView(view('working'))
  const [win] = env.windows
  win.handlers['did-finish-load']()
  desk.startDrag({ x: 720, y: 81 })
  desk.setIslandRect({ x: 260, y: 136, width: 80, height: 80 }, win.lastView().layoutVersion, true)
  const initial = dragBounds({ x: 40, y: 65 })
  assert.deepEqual([win.lastView().dragging, win.bounds], [true, initial], 'the portrait stays under the pointer, kept on the screen')
  Object.assign(env.cursor, { x: 1080, y: 681.25 })
  t.mock.timers.tick(200)
  assert.equal(win.bounds.x, initial.x, 'no timer moves it: the page\'s frames do')
  desk.dragMove()
  assert.deepEqual(win.bounds, dragBounds({ x: 1080, y: 681.25 }))
  desk.endDrag()
  assert.deepEqual([win.bounds.width, win.bounds.height, win.lastView().dir], [DESK_SIZE.width, DESK_SIZE.height, 'up'])
  assert.deepEqual(env.saved(), { last: '1', places: { 1: { fx: 0.75, fy: 0.75 } } })
  assert.equal(win.lastView().dragging, false)
  desk.resetPlace()
  assert.deepEqual(env.saved(), { last: null, places: {} })
  const area = env.screen.getAllDisplays()[0].workArea
  assert.deepEqual(win.bounds, deskLayout(homePoint(area), area).bounds, 'back at the top centre')
  desk.destroy()
})

test('closed to the tray the cat stays on the desktop; the window shown again takes it away', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes()
  const desk = deskIsland(env)
  desk.setView(view('idle'))
  const [win] = env.windows
  win.handlers['did-finish-load']()
  assert.deepEqual([win.visible, win.lastView().form], [true, 'mini'])
  desk.setAway(false)
  assert.equal(win.visible, false)
  desk.destroy()
})

test('done stays up while the pointer rests on it, and a moment after it leaves', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const env = fakes({ cursor: { x: 700, y: 50 } })
  const desk = deskIsland(env)
  const [win] = (desk.setView(view('done')), env.windows)
  win.handlers['did-finish-load']()
  const anchor = win.lastView().anchor
  Object.assign(env.cursor, { x: win.bounds.x + anchor.x, y: win.bounds.y + anchor.y })
  desk.setIslandRect({ x: anchor.x - 40, y: anchor.y - 40, width: 80, height: 80 })
  t.mock.timers.tick(DESK_TIMES.done + 1000)
  assert.equal(win.lastView().form, 'done', 'held while the pointer is over it')
  env.cursor.x = 100
  t.mock.timers.tick(60)
  t.mock.timers.tick(DESK_TIMES.linger - 100)
  assert.equal(win.lastView().form, 'done')
  t.mock.timers.tick(200)
  assert.equal(win.lastView().form, 'mini')
  desk.destroy()
})

test('the first time the cat rests on the desktop it says what it can do, until the user has seen it', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes()
  let coached = false
  const coach = { get: () => coached, set: () => { coached = true } }
  const desk = deskIsland(env, { coach })
  desk.setView(view('idle'))
  const [win] = env.windows
  win.handlers['did-finish-load']()
  assert.equal(win.lastView().coach, true)
  desk.markCoached()
  assert.deepEqual([coached, win.lastView().coach], [true, false])
  desk.destroy()

  coached = false
  const dragged = deskIsland(fakes(), { coach })
  dragged.setView(view('idle'))
  dragged.startDrag()
  assert.equal(coached, true, 'dragging the island, or opening its input, shows the user found it')
  dragged.destroy()
})

test('a click on the cat opens what its state needs: the request, how it ended, what is missing, or the input', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes()
  const desk = deskIsland(env)
  desk.setView(view('idle'))
  const [win] = env.windows
  win.handlers['did-finish-load']()
  const opened = (form: string) => {
    desk.setView(view(form))
    desk.togglePanel()
    const { panel } = win.lastView() as unknown as { panel: string }
    desk.closeInput()
    return panel
  }
  assert.deepEqual(['waiting', 'asking', 'done', 'error', 'pending', 'idle'].map(opened),
    ['request', 'request', 'status', 'status', 'status', 'input'], 'not connected, the card says what is missing rather than a field that cannot be typed in')
  desk.destroy()
})

test('the right-click menu: ask, open, stop only while working, put back, hide for now or for good', () => {
  const calls: string[] = []
  const make = (working: boolean) => deskMenuTemplate({
    working, shortcut: 'CommandOrControl+Shift+Space',
    ask: () => calls.push('ask'), open: () => calls.push('open'), stop: () => calls.push('stop'),
    resetPlace: () => calls.push('reset'), hide: () => calls.push('hide'), switchOff: () => calls.push('off'),
  })
  const items = make(true).filter((item) => item.type !== 'separator')
  assert.deepEqual(items.map((item) => item.label), [
    '提问…', '打开 Viva 窗口', '停止', '放回顶部正中', '先隐藏（下次关闭窗口时再出现）', '不再显示桌面岛（可在设置里打开）',
  ])
  assert.equal(items[0].registerAccelerator, false, 'the shortcut is shown, not registered twice')
  for (const item of items) {
    assert.ok(item.click)
    Reflect.apply(item.click, undefined, [])
  }
  assert.deepEqual(calls, ['ask', 'open', 'stop', 'reset', 'hide', 'off'])
  assert.equal(make(false).find((item) => item.label === '停止')?.enabled, false)
})

test('the island may open its menu, open its input and say the user has seen what it can do', () => {
  assert.deepEqual([checkIslandAction({ kind: 'menu', x: 1 }), checkIslandAction({ kind: 'coached' })], [{ kind: 'menu' }, { kind: 'coached' }])
})

test('hidden from its menu, the island stays away until the window is next closed to the tray', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes()
  const desk = deskIsland(env)
  desk.setView(view('working'))
  const [win] = env.windows
  desk.hideUntilAway()
  assert.equal(win.visible, false)
  desk.setView(view('waiting'))
  assert.equal(win.visible, false, 'not even for what needs the user: the window still has it')
  assert.equal(desk.openInput(), true, 'the shortcut still calls it up')
  desk.closeInput()
  assert.equal(win.visible, false)
  desk.setAway(false)
  desk.setAway(true)
  assert.equal(env.windows.at(-1)?.visible, true, 'back once the window is closed again')
  desk.destroy()
})

test('gone and back, the island is a new window, letting the pointer through until it is over the island', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes()
  const desk = deskIsland(env)
  desk.setView(view('waiting'))
  const [first] = env.windows
  desk.setAway(false)
  assert.equal(first.isDestroyed(), true, 'closed, not hidden: on Windows a hidden one shown again lost its left button presses')
  desk.setAway(true)
  const second = env.windows.at(-1)
  assert.ok(second)
  assert.notEqual(second, first)
  assert.deepEqual([second.visible, second.ignoring], [true, [true]])
  desk.destroy()
})

test('drag resizing waits for the current compact layout and rejects stale or incomplete reports', { skip: FIXED_DESK_HOST }, (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes({ cursor: { x: 700, y: 200 } })
  const desk = deskIsland(env)
  const [win] = env.windows
  win.handlers['did-finish-load']()
  desk.startDrag({ x: 720, y: 81 })
  const version = win.lastView().layoutVersion
  const compact = { x: 260, y: 136, width: 80, height: 80 }
  assert.equal(win.bounds.width, DESK_SIZE.width)
  desk.dragMove()
  desk.setIslandRect(compact, version - 1, true)
  desk.setIslandRect(compact, version, false)
  desk.setIslandRect({ ...compact, width: 520 }, version, true)
  assert.equal(win.bounds.width, 600)
  desk.setIslandRect(compact, version, true)
  assert.deepEqual(win.bounds, { x: 648, y: 148, width: 104, height: 104 })
  if (process.platform === 'win32') assert.deepEqual(win.shape, [{ x: 8, y: 8, width: 88, height: 88 }])
  desk.destroy()
})

test('a quick release saves the latest cursor and invalidates the outstanding compact acknowledgement', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes({ cursor: { x: 700, y: 200 } })
  const desk = deskIsland(env)
  const [win] = env.windows
  win.handlers['did-finish-load']()
  desk.startDrag({ x: 720, y: 81 })
  const oldVersion = win.lastView().layoutVersion
  Object.assign(env.cursor, { x: 1080, y: 681.25 })
  desk.endDrag()
  desk.setIslandRect({ x: 12, y: 12, width: 80, height: 80 }, oldVersion, true)
  t.mock.timers.tick(LAYOUT_READY_MS + 1)
  assert.equal(win.bounds.width, DESK_SIZE.width)
  assert.equal(win.lastView().dragging, false)
  assert.ok(win.lastView().layoutVersion > oldVersion)
  assert.deepEqual(env.saved(), { last: '1', places: { 1: { fx: .75, fy: .75 } } })
  desk.destroy()
})

test('Windows follows a drag immediately and keeps its canvas, anchor and hit region through release', { skip: !FIXED_DESK_HOST }, t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes({ cursor: { x: 738, y: 74 } })
  const desk = deskIsland(env)
  t.after(() => desk.destroy())
  const win = env.windows[0]
  win.handlers['did-finish-load']()
  desk.openInput()
  const anchor = win.lastView().anchor
  const rect = { x: anchor.x - 40, y: anchor.y - 40, width: 80, height: 80 }
  desk.setIslandRect(rect, win.lastView().layoutVersion, true, [rect, { x: anchor.x + 52, y: rect.y, width: 440, height: 260 }])
  desk.startDrag({ ...env.cursor })
  const dragVersion = win.lastView().layoutVersion
  assert.equal(win.shape.length, 1, 'keep only the known portrait region while the panel collapses')
  const mask = [...win.shape]
  for (const point of [{ x: 900, y: 600 }, { x: 500, y: 200 }, { x: 1080, y: 700 }]) {
    Object.assign(env.cursor, point)
    desk.dragMove()
    assert.deepEqual(win.bounds, dragBounds({ x: point.x - 18, y: point.y + 7 }), 'movement does not wait for a renderer acknowledgement')
  }
  const beforeRelease = { ...win.bounds }
  desk.endDrag()
  assert.deepEqual(win.bounds, beforeRelease, 'release does not relocate or resize the canvas')
  assert.deepEqual(win.lastView().anchor, anchor)
  assert.deepEqual(win.shape, mask, 'release never temporarily enables a full rectangular native region')
  assert.ok(win.boundsHistory.every(bounds => bounds.width === DESK_SIZE.width && bounds.height === DESK_SIZE.height))
  assert.equal(desk.inputOpen(), false)
  const calls = win.shapeCalls
  desk.setIslandRect({ x: 12, y: 12, width: 80, height: 80 }, dragVersion, true)
  desk.setIslandRect({ x: 12, y: 12, width: 80, height: 80 }, win.lastView().layoutVersion, false)
  assert.equal(win.shapeCalls, calls, 'neither old-version nor not-yet-committed geometry can replace the mask')
  desk.setIslandRect(rect, win.lastView().layoutVersion, true, [rect])
  assert.deepEqual(win.shape, mask)
  assert.deepEqual(env.saved(), { last: '1', places: { 1: { fx: 1062 / 1440, fy: (707 - 25) / 875 } } })
})

test('fixed-host placement reports the screen viewport and invalidates acknowledgements on reset', { skip: !FIXED_DESK_HOST }, t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes(), desk = deskIsland(env)
  t.after(() => desk.destroy())
  const win = env.windows[0]
  win.handlers['did-finish-load']()
  const homeVersion = win.lastView().layoutVersion
  desk.placeAt('right-bottom')
  const movedVersion = win.lastView().layoutVersion
  assert.ok(movedVersion > homeVersion)
  assert.deepEqual(win.lastView().viewport, { top: 25 - win.bounds.y, bottom: 900 - win.bounds.y })
  desk.resetPlace()
  assert.ok(win.lastView().layoutVersion > movedVersion)
  const calls = win.shapeCalls
  desk.setIslandRect({ x: 12, y: 12, width: 80, height: 80 }, movedVersion, true)
  assert.equal(win.shapeCalls, calls)
})

test('a delayed renderer keeps a full surface until its compact acknowledgement arrives', { skip: FIXED_DESK_HOST }, (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes({ cursor: { x: 900, y: 500 } })
  const desk = deskIsland(env)
  const [win] = env.windows
  win.handlers['did-finish-load']()
  desk.startDrag({ x: 720, y: 81 })
  const version = win.lastView().layoutVersion
  t.mock.timers.tick(LAYOUT_READY_MS + 1)
  assert.deepEqual(win.bounds, { x: 840, y: 450, width: 600, height: 352 })
  desk.setIslandRect({ x: 260, y: 136, width: 80, height: 80 }, version, true)
  assert.deepEqual(win.bounds, { x: 848, y: 448, width: 104, height: 104 })
  desk.endDrag()
  assert.equal(win.ignoring.at(-1), true)
  desk.setIslandRect({ x: 80, y: 10, width: 440, height: 72 }, version, true)
  assert.equal(win.ignoring.at(-1), true)
  desk.setIslandRect({ x: 80, y: 10, width: 440, height: 72 }, win.lastView().layoutVersion, true)
  if (process.platform === 'win32') assert.deepEqual(win.shape, [{ x: 76, y: 6, width: 448, height: 80 }])
  desk.destroy()
})

test('layout acknowledgements cross IPC with a finite version and a boolean readiness flag', () => {
  const rect = { kind: 'rect', x: 0, y: 0, width: 80, height: 80 }
  assert.deepEqual(checkIslandAction({ ...rect, version: 3, ready: true }), { ...rect, version: 3, ready: true })
  for (const version of [-1, .5, Infinity, '1']) assert.equal(checkIslandAction({ ...rect, version, ready: true }), null)
  assert.equal(checkIslandAction({ ...rect, ready: true }), null)
  assert.equal(checkIslandAction({ ...rect, version: 1, ready: 'yes' }), null)
  assert.deepEqual(checkIslandAction({ kind: 'settings', path: '/other' }), { kind: 'settings' })
})

test('dragging preserves an off-centre grab, and cancellation restores position and expansion without saving', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes({ cursor: { x: 860, y: 240 } })
  const desk = deskIsland(env)
  desk.openInput()
  const win = env.windows[0]
  win.handlers['did-finish-load']()
  const original = { ...win.bounds }
  desk.startDrag({ x: 740, y: 100 })
  desk.setIslandRect({ x: 20, y: 10, width: 80, height: 80 }, win.lastView().layoutVersion, true)
  assert.deepEqual(win.bounds, dragBounds({ x: 840, y: 221 }), 'the 20px/19px grab offset remains under the pointer')
  desk.endDrag(true)
  assert.deepEqual(win.bounds, original)
  assert.deepEqual(env.saved(), { last: null, places: {} })
  assert.equal(desk.inputOpen(), true)
  desk.destroy()
})

test('native hit regions preserve the transparent gap between the portrait and its panel', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes(), desk = deskIsland(env)
  const win = env.windows[0]
  win.handlers['did-finish-load']()
  desk.setIslandRect({ x: 20, y: 10, width: 80, height: 80 }, 0, true, [
    { x: 20, y: 10, width: 80, height: 80 }, { x: 112, y: 10, width: 440, height: 260 },
  ])
  if (process.platform === 'win32') {
    assert.equal(win.shape.length, 2)
    assert.ok(win.shape[0].x + win.shape[0].width < win.shape[1].x)
  }
  desk.destroy()
})

test('its 已完成 card read and closed tells the window it was seen; other cards, or done never opened, do not', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes()
  let read = 0
  const desk = deskIsland(env, { onDoneRead: () => { read += 1 } })
  const [win] = env.windows
  win.handlers['did-finish-load']()
  desk.setView(view('done'))
  desk.closeInput()
  assert.equal(read, 0, 'nothing open: nothing read')
  desk.togglePanel()
  assert.equal(read, 0, 'open, being read')
  desk.togglePanel()
  assert.equal(read, 1, 'closed: read')
  desk.setView(view('error'))
  desk.togglePanel()
  desk.closeInput()
  desk.setView(view('done'))
  desk.openInput()
  desk.closeInput()
  assert.equal(read, 1, 'how it went wrong, or the input over a done island, is not the done card')
  desk.destroy()
})
