import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDeskIsland, DESK_TIMES, deskForm } from '../src/main/desk-island.js'
import { deskMenuTemplate } from '../src/main/desk-menu.js'
import { describeDropped, MISSING, NOT_A_FILE } from '../src/main/island-files.js'
import { ASK_LIMITS, checkAsk, checkDroppedPaths, checkIslandAction, checkIslandView } from '../src/main/island-ipc.js'

const view = (form, extra = {}) => ({ form, tone: 'idle', mood: 'idle', label: 'x', recent: [], ...extra })
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
  assert.deepEqual(checkAsk({ text: '  总结 ', files: ['/a/b.docx'], extra: 1 }), { text: '总结', files: ['/a/b.docx'] })
  assert.deepEqual(checkAsk({ text: '在吗' }), { text: '在吗', files: [] })
  assert.equal(checkAsk({ text: '   ' }), null)
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
  const windows = []
  class FakeWindow {
    constructor(options) {
      this.visible = false
      this.focusable = options.focusable
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
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setContentProtection() {}
    setIgnoreMouseEvents(value) { this.ignoring.push(value) }
    loadFile() {}
    on(event, callback) { this.handlers[event] = callback }
    isDestroyed() { return false }
    destroy() {}
    isVisible() { return this.visible }
    showInactive() { this.visible = true }
    hide() { this.visible = false }
    setBounds(bounds) { this.bounds = bounds }
    getBounds() { return this.bounds }
    setFocusable(value) { this.focusable = value }
    focus() { this.focused = this.focusable }
    isFocused() { return this.focused }
    blur() { this.focused = false }
    lastView() { return this.sent.filter(([channel]) => channel === 'island:view').at(-1)?.[1] }
  }
  const screen = {
    getAllDisplays: () => [display],
    getDisplayMatching: () => display,
    getDisplayNearestPoint: () => display,
    getCursorScreenPoint: () => ({ ...cursor }),
  }
  let saved = { last: null, places: {} }
  const places = { get: () => saved, set: (value) => { saved = value } }
  return { windows, screen, cursor, places, saved: () => saved, BrowserWindow: FakeWindow }
}

function deskIsland(env, extra = {}) {
  const desk = createDeskIsland({
    BrowserWindow: env.BrowserWindow, screen: env.screen, preload: 'p', page: 'q', mainWindow: { getBounds: () => ({}) },
    enabled: true, places: env.places, ...extra,
  })
  desk.setAway(true)
  return desk
}

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
  assert.deepEqual([win.focusable, win.focused, win.visible, win.lastView().form], [false, false, true, 'working'], 'what was asked stays up while it runs')
  desk.setView(view('idle'))
  assert.equal(win.visible, false, 'switched off, it goes once that is over')
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

test('clicks reach the island only while the pointer is over it', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes({ cursor: { x: 700, y: 50 } })
  const desk = deskIsland(env)
  desk.setView(view('working'))
  const [win] = env.windows
  desk.setIslandRect({ x: 150, y: 10, width: 300, height: 48 })
  assert.equal(win.ignoring.at(-1), false, 'the pointer is over the island (its window at x 420, y 31)')
  env.cursor.x = 100
  t.mock.timers.tick(60)
  assert.equal(win.ignoring.at(-1), true)
  desk.destroy()
})

test('dragged, the island shrinks to the cat, follows the pointer at each frame, and is remembered where it is let go', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const env = fakes()
  const desk = deskIsland(env)
  desk.setView(view('working'))
  const [win] = env.windows
  win.handlers['did-finish-load']()
  desk.startDrag()
  assert.deepEqual([win.lastView().dragging, win.bounds], [true, { x: -12, y: 13, width: 72, height: 72 }], 'just the cat, under the pointer, kept on the screen')
  Object.assign(env.cursor, { x: 1080, y: 681.25 })
  t.mock.timers.tick(200)
  assert.equal(win.bounds.x, -12, 'no timer moves it: the page\'s frames do')
  desk.dragMove()
  assert.deepEqual(win.bounds, { x: 1044, y: 645, width: 72, height: 72 })
  desk.endDrag()
  assert.deepEqual([win.bounds.width, win.bounds.height, win.lastView().dir], [600, 320, 'up'], 'its full size again, opening upwards')
  assert.deepEqual(env.saved(), { last: '1', places: { 1: { fx: 0.75, fy: 0.75 } } })
  assert.equal(win.lastView().dragging, false)
  desk.resetPlace()
  assert.deepEqual([env.saved(), win.bounds.x, win.bounds.y], [{ last: null, places: {} }, 420, 31], 'back at the top centre')
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
  desk.setIslandRect({ x: 150, y: 10, width: 300, height: 48 })
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

test('the right-click menu: ask, open, stop only while working, put back, hide for now or for good', () => {
  const calls = []
  const make = (working) => deskMenuTemplate({
    working, shortcut: 'CommandOrControl+Shift+Space',
    ask: () => calls.push('ask'), open: () => calls.push('open'), stop: () => calls.push('stop'),
    resetPlace: () => calls.push('reset'), hide: () => calls.push('hide'), switchOff: () => calls.push('off'),
  })
  const items = make(true).filter((item) => item.type !== 'separator')
  assert.deepEqual(items.map((item) => item.label), [
    '提问…', '打开 Viva 窗口', '停止', '放回顶部正中', '先隐藏（下次关闭窗口时再出现）', '不再显示桌面岛（可在设置里打开）',
  ])
  assert.equal(items[0].registerAccelerator, false, 'the shortcut is shown, not registered twice')
  for (const item of items) item.click()
  assert.deepEqual(calls, ['ask', 'open', 'stop', 'reset', 'hide', 'off'])
  assert.equal(make(false).find((item) => item.label === '停止').enabled, false)
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
  assert.equal(win.visible, true, 'back once the window is closed again')
  desk.destroy()
})
