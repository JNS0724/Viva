import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createTray } from '../src/shell/tray.ts'
import { setLocale } from '../src/shared/i18n/locale.ts'

type MenuEntry = { label?: string, type?: string, click?: () => void }

/** A stand-in for Electron's Tray, Menu and nativeImage, recording what the tray was given. */
function fakes() {
  const made = {
    image: '',
    tooltip: '',
    menu: [] as MenuEntry[],
    template: false,
    handlers: {} as Record<string, () => void>,
    destroyed: false,
  }
  class FakeTray {
    constructor(image: { file: string }) { made.image = image.file }
    setToolTip(text: string) { made.tooltip = text }
    setContextMenu(menu: unknown) { made.menu = menu as MenuEntry[] }
    on(event: string, callback: () => void) { made.handlers[event] = callback }
    destroy() { made.destroyed = true }
  }
  const nativeImage = { createFromPath: (file: string) => ({ file, setTemplateImage: (on: boolean) => { made.template = on } }) }
  const Menu = { buildFromTemplate: (items: MenuEntry[]) => items } as unknown as typeof import('electron').Menu
  const nativeImageTyped = nativeImage as unknown as typeof import('electron').nativeImage
  return { made, deps: { Tray: FakeTray as unknown as typeof import('electron').Tray, Menu, nativeImage: nativeImageTyped, iconDir: '/icons' } }
}

test('the tray menu opens the window or quits; on Windows a click opens the window', () => {
  const { made, deps } = fakes()
  const calls: string[] = []
  const tray = createTray({ ...deps, platform: 'win32', onOpen: () => calls.push('open'), onQuit: () => calls.push('quit') })
  assert.deepEqual([made.image, made.template, made.tooltip], [path.join('/icons', 'tray.png'), false, 'Viva'])
  const items = made.menu.filter((item) => item.label)
  assert.deepEqual(items.map((item) => item.label), ['打开 Viva', '退出 Viva'])
  items.forEach((item) => item.click?.())
  made.handlers.click()
  assert.deepEqual(calls, ['open', 'quit', 'open'])
  tray.destroy()
  assert.equal(made.destroyed, true)
})

test('macOS gets a template image for the menu bar, a click shows the menu, and refresh updates menu labels', () => {
  const { made, deps } = fakes()
  const tray = createTray({ ...deps, platform: 'darwin', onOpen() {}, onQuit() {} })
  assert.deepEqual([made.image, made.template, made.handlers.click], [path.join('/icons', 'trayTemplate.png'), true, undefined])
  setLocale('en')
  try {
    tray.refresh()
    assert.deepEqual(made.menu.filter((item) => item.label).map((item) => item.label), ['Open Viva', 'Quit Viva'])
  } finally {
    setLocale('zh-CN')
  }
})
