import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { TITLEBAR_HEIGHT, devIcon, titleBarOverlay, windowBackground, windowChrome, windowSize } from '../src/shell/window-options.ts'

test('macOS keeps its traffic lights, inset and centred in the title bar', () => {
  const chrome = windowChrome('darwin')

  assert.equal(chrome.titleBarStyle, 'hiddenInset')
  assert.equal(chrome.titleBarOverlay, undefined)
  assert.equal(chrome.trafficLightPosition?.y, 29, 'lights are about 14px tall, so they sit centred in 72px')
})

test('Windows and Linux get system-drawn window buttons in a matching dark or light overlay', () => {
  for (const platform of ['win32', 'linux']) {
    const dark = windowChrome(platform)
    assert.equal(dark.titleBarStyle, 'hidden')
    assert.deepEqual(dark.titleBarOverlay, { color: '#060B16', symbolColor: '#A3B0CC', height: TITLEBAR_HEIGHT })
    assert.equal(dark.trafficLightPosition, undefined)

    const light = windowChrome(platform, 'light')
    assert.equal(light.titleBarStyle, 'hidden')
    assert.deepEqual(light.titleBarOverlay, { color: '#F2F5FA', symbolColor: '#3B4C68', height: TITLEBAR_HEIGHT })
    assert.deepEqual(titleBarOverlay('light'), light.titleBarOverlay)
  }
  assert.equal(windowBackground('dark'), '#060B16')
  assert.equal(windowBackground('light'), '#F2F5FA')
})

test('the window fits the screen it opens on, including a scaled laptop display', () => {
  const roomy = windowSize({ width: 2560, height: 1400 })
  const scaledLaptop = windowSize({ width: 1280, height: 680 })
  const tiny = windowSize({ width: 800, height: 560 })

  assert.deepEqual(roomy, { width: 1360, height: 860, minWidth: 880, minHeight: 600 })
  assert.deepEqual(scaledLaptop, { width: 1152, height: 612, minWidth: 880, minHeight: 600 })
  assert.deepEqual(tiny, { width: 720, height: 504, minWidth: 720, minHeight: 504 }, 'minimums never exceed the window itself')
})

test('run from the repository, the app uses its own icon (the .ico on Windows); a built app keeps the packaged one', () => {
  const appRoot = path.join('/repo')
  assert.equal(devIcon({ platform: 'darwin', packaged: false, appRoot }), path.join(appRoot, 'build', 'icons', 'viva.png'))
  assert.equal(devIcon({ platform: 'win32', packaged: false, appRoot }), path.join(appRoot, 'build', 'icons', 'viva.ico'))
  assert.equal(devIcon({ platform: 'linux', packaged: false, appRoot }), path.join(appRoot, 'build', 'icons', 'viva.png'))
  assert.equal(devIcon({ platform: 'darwin', packaged: true, appRoot }), null)
})
