import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTray } from '../src/main/tray.js'

/** A stand-in for Electron's Tray, Menu and nativeImage, recording what the tray was given. */
function fakes() {
  const made = { template: false, handlers: {}, destroyed: false }
  class FakeTray {
    constructor(image) { made.image = image.file }
    setToolTip(text) { made.tooltip = text }
    setContextMenu(menu) { made.menu = menu }
    on(event, callback) { made.handlers[event] = callback }
    destroy() { made.destroyed = true }
  }
  const nativeImage = { createFromPath: (file) => ({ file, setTemplateImage: (on) => { made.template = on } }) }
  const Menu = { buildFromTemplate: (items) => items }
  return { made, deps: { Tray: FakeTray, Menu, nativeImage, iconDir: '/icons' } }
}

test('the tray menu opens the window or quits; on Windows a click opens the window', () => {
  const { made, deps } = fakes()
  const calls = []
  const tray = createTray({ ...deps, platform: 'win32', onOpen: () => calls.push('open'), onQuit: () => calls.push('quit') })
  assert.deepEqual([made.image, made.template, made.tooltip], ['/icons/tray.png', false, 'Viva'])
  const items = made.menu.filter((item) => item.label)
  assert.deepEqual(items.map((item) => item.label), ['打开 Viva', '退出 Viva'])
  items.forEach((item) => item.click())
  made.handlers.click()
  assert.deepEqual(calls, ['open', 'quit', 'open'])
  tray.destroy()
  assert.equal(made.destroyed, true)
})

test('macOS gets a template image for the menu bar, and a click shows the menu', () => {
  const { made, deps } = fakes()
  createTray({ ...deps, platform: 'darwin', onOpen() {}, onQuit() {} })
  assert.deepEqual([made.image, made.template, made.handlers.click], ['/icons/trayTemplate.png', true, undefined])
})
