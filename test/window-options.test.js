import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TITLEBAR_HEIGHT, windowChrome, windowSize } from '../src/main/window-options.js'

test('macOS keeps its traffic lights, inset and centred in the shorter title bar', () => {
  const chrome = windowChrome('darwin')

  assert.equal(chrome.titleBarStyle, 'hiddenInset')
  assert.equal(chrome.titleBarOverlay, undefined)
  assert.equal(chrome.trafficLightPosition.y, 17, 'lights are about 14px tall, so they sit centred in 48px')
})

test('Windows and Linux get system-drawn window buttons in a matching overlay', () => {
  for (const platform of ['win32', 'linux']) {
    const chrome = windowChrome(platform)
    assert.equal(chrome.titleBarStyle, 'hidden')
    assert.deepEqual(chrome.titleBarOverlay, { color: '#060B16', symbolColor: '#A3B0CC', height: TITLEBAR_HEIGHT })
    assert.equal(chrome.trafficLightPosition, undefined)
  }
})

test('the window fits the screen it opens on, including a scaled laptop display', () => {
  const roomy = windowSize({ width: 2560, height: 1400 })
  const scaledLaptop = windowSize({ width: 1280, height: 680 })
  const tiny = windowSize({ width: 800, height: 560 })

  assert.deepEqual(roomy, { width: 1360, height: 860, minWidth: 880, minHeight: 600 })
  assert.deepEqual(scaledLaptop, { width: 1152, height: 612, minWidth: 880, minHeight: 600 })
  assert.deepEqual(tiny, { width: 720, height: 504, minWidth: 720, minHeight: 504 }, 'minimums never exceed the window itself')
})
