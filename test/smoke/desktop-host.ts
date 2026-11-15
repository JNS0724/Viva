import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { DESK_SIZE, pointOf, readPlaces } from '../../src/shell/desk-place.ts'
import fs from 'node:fs'
import path from 'node:path'

/** Reuse the startup instance to cover the native fixed host, real IPC and queued renderer placement. */
export async function checkDesktopHost(application: ElectronApplication, desktop: Page, info: TestInfo): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return
  const result = await application.evaluate(async ({ BrowserWindow, screen }, size) => {
    const desk = globalThis.vivaAutomation!.desk()!
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/desk.html'))!
    type Geometry = { kind: 'rect', x: number, y: number, width: number, height: number, version: number, ready: boolean }
    const reports: Geometry[] = []
    const bounds: Electron.Rectangle[] = []
    const requested: Array<Partial<Electron.Rectangle>> = []
    const originalCursor = screen.getCursorScreenPoint.bind(screen)
    const originalBounds = window.setBounds.bind(window)
    const originalSend = window.webContents.send.bind(window.webContents)
    let originalView: Parameters<typeof desk.setView>[0] | undefined
    let pointer = originalCursor()
    const record = (_event: unknown, channel: string, value: unknown) => {
      if (channel === 'island:act' && value && typeof value === 'object' && 'kind' in value && value.kind === 'rect') reports.push(value as Geometry)
    }
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    const version = () => reports.at(-1)?.version ?? -1
    async function settled(after: number) {
      const deadline = Date.now() + 5000
      while (!reports.some(report => report.version > after && report.ready)) {
        if (Date.now() > deadline) throw new Error('No committed desktop geometry after version ' + after)
        await wait(10)
      }
    }
    window.webContents.on('ipc-message', record)
    window.webContents.send = (channel, ...args) => {
      if (channel === 'island:view' && !originalView) originalView = (args[0] as { view: Parameters<typeof desk.setView>[0] }).view
      originalSend(channel, ...args)
    }
    window.setBounds = (next, animate) => { requested.push({ ...next }); originalBounds(next, animate); bounds.push(window.getBounds()) }
    screen.getCursorScreenPoint = () => pointer
    const corners = [], drags = []
    let updates = 0
    let producer: ReturnType<typeof setInterval> | undefined
    try {
      let beforeVersion = version()
      desk.resetPlace()
      await settled(beforeVersion)
      for (const corner of ['left-top', 'right-top', 'left-bottom', 'right-bottom']) {
        beforeVersion = version()
        desk.closeInput()
        desk.placeAt(corner)
        await settled(beforeVersion)
        desk.openInput()
        const deadline = Date.now() + 5000
        let panel: Electron.Rectangle | null = null
        while (!panel) {
          panel = await window.webContents.executeJavaScript(`(() => {
            const element = document.querySelector('.isl-surface:not([hidden])'); if (!element) return null;
            const rect = element.getBoundingClientRect(); return rect.width > 0 ? rect.toJSON() : null;
          })()`)
          if (Date.now() > deadline) throw new Error('No visible desktop panel at ' + corner)
          if (!panel) { desk.openInput(); await wait(30) }
        }
        // Include queued placement after opening, rather than sampling its initial DOM geometry.
        await wait(150)
        const current = await window.webContents.executeJavaScript(`document.querySelector('.isl-surface:not([hidden])')?.getBoundingClientRect().toJSON()`)
        if (!current) throw new Error('Desktop input closed at ' + corner)
        const native = window.getBounds()
        const area = screen.getDisplayNearestPoint({ x: Math.round(native.x + size.width / 2), y: Math.round(native.y + size.height / 2) }).workArea
        corners.push({ corner, native, panel: current, area,
          contained: native.x + current.x >= area.x - 1 && native.y + current.y >= area.y - 1
            && native.x + current.x + current.width <= area.x + area.width + 1 && native.y + current.y + current.height <= area.y + area.height + 1 })
      }
      // Same-version status updates must not restart layout readiness indefinitely.
      producer = setInterval(() => desk.setView({ form: 'working', tone: 'working', mood: 'thinking',
        label: '正在处理', recent: [], action: '状态刷新 ' + ++updates }), 16)
      await wait(200)
      beforeVersion = version()
      desk.resetPlace()
      await settled(beforeVersion)
      await wait(150)
      clearInterval(producer)
      producer = undefined
      if (originalView) desk.setView(originalView)
      beforeVersion = version()
      desk.resetPlace()
      await settled(beforeVersion)
      const initial = window.getBounds()
      pointer = { x: initial.x + size.width / 2 + 18, y: initial.y + size.height / 2 - 7 }
      for (const cancel of [false, true]) {
        desk.openInput()
        await wait(150)
        if (!desk.inputOpen()) { desk.openInput(); await wait(150) }
        const expandedBefore = desk.inputOpen()
        const origin = window.getBounds()
        const from = { ...pointer }
        beforeVersion = version()
        desk.startDrag(from)
        await settled(beforeVersion)
        const area = screen.getDisplayNearestPoint(from).workArea
        const fraction = cancel ? .24 : .76
        const target = { x: area.x + Math.round(area.width * fraction), y: area.y + Math.round(area.height * fraction) }
        for (let step = 1; step <= 10; step++) {
          pointer = { x: from.x + Math.round((target.x - from.x) * step / 10), y: from.y + Math.round((target.y - from.y) * step / 10) }
          desk.dragMove()
          await wait(16)
        }
        const beforeRelease = window.getBounds()
        beforeVersion = version()
        desk.endDrag(cancel)
        await settled(beforeVersion)
        drags.push({ cancel, expandedBefore, origin, beforeRelease, after: window.getBounds(), expandedAfter: desk.inputOpen() })
      }
      return { corners, drags, reports, bounds, requested, updates, scaleFactor: screen.getPrimaryDisplay().scaleFactor }
    } finally {
      clearInterval(producer)
      screen.getCursorScreenPoint = originalCursor
      window.setBounds = originalBounds
      window.webContents.send = originalSend
      window.webContents.removeListener('ipc-message', record)
      if (originalView) desk.setView(originalView)
      desk.closeInput()
      desk.resetPlace()
    }
  }, DESK_SIZE)
  const resultFile = info.outputPath('fixed-desktop-host.json')
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2))
  await info.attach('fixed-desktop-host', { path: resultFile, contentType: 'application/json' })
  for (const corner of result.corners) expect(corner.contained, corner.corner).toBe(true)
  expect(result.updates).toBeGreaterThan(5)
  expect(result.bounds.length).toBeGreaterThan(10)
  for (const bounds of result.requested) {
    expect(bounds.width).toBe(DESK_SIZE.width)
    expect(bounds.height).toBe(DESK_SIZE.height)
  }
  // Windows rounds each native edge separately at fractional DPI, including negative host origins.
  const edgeRounding = Math.ceil(2 / result.scaleFactor)
  for (const [index, bounds] of result.bounds.entries()) {
    expect(Math.abs(bounds.width - DESK_SIZE.width)).toBeLessThanOrEqual(edgeRounding)
    expect(Math.abs(bounds.height - DESK_SIZE.height)).toBeLessThanOrEqual(edgeRounding)
    if (process.platform === 'darwin') {
      const requested = result.requested[index]
      expect(bounds.x).toBe(requested.x)
      expect(bounds.y).toBe(requested.y)
    }
  }
  for (const report of result.reports) {
    expect(Math.abs(report.x - (DESK_SIZE.width / 2 - 40)), JSON.stringify(report)).toBeLessThanOrEqual(1)
    expect(Math.abs(report.y - (DESK_SIZE.height / 2 - 40)), JSON.stringify(report)).toBeLessThanOrEqual(1)
  }
  for (const drag of result.drags) {
    const expected = drag.cancel ? drag.origin : drag.beforeRelease
    expect(Math.abs(drag.beforeRelease.x - drag.origin.x)).toBeGreaterThan(20)
    expect(Math.abs(drag.beforeRelease.y - drag.origin.y)).toBeGreaterThan(20)
    expect(Math.abs(drag.after.x - expected.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(drag.after.y - expected.y)).toBeLessThanOrEqual(1)
    expect(drag.expandedBefore).toBe(true)
    expect(drag.expandedAfter).toBe(drag.cancel)
  }
  await desktop.screenshot({ path: info.outputPath('fixed-desktop-host.png') })
}

/** CDP sends trusted Chromium pointer events. Supply their screen coordinates to the native mover as well. */
export async function checkDesktopDragRelease(application: ElectronApplication, desktop: Page): Promise<void> {
  const avatar = desktop.locator('.isl-anchor')
  const stage = desktop.locator('#desk')
  await expect(avatar).toBeVisible()
  const cdp = await desktop.context().newCDPSession(desktop)
  const audit = await application.evaluateHandle(({ app, BrowserWindow, screen }) => {
    const desk = globalThis.vivaAutomation!.desk()!
    const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/desk.html'))!
    const cursor = screen.getCursorScreenPoint.bind(screen)
    let point = cursor()
    const actions: string[] = []
    const record = (_event: unknown, channel: string, action: { kind?: string, phase?: string }) => {
      if (channel !== 'island:act') return
      if (action.kind === 'drag' && action.phase !== 'move') actions.push(String(action.phase))
      if (action.kind === 'toggle') actions.push('toggle')
    }
    screen.getCursorScreenPoint = () => point
    host.webContents.on('ipc-message', record)
    desk.markCoached()
    desk.closeInput()
    desk.resetPlace()
    return {
      move: (next: { x: number, y: number }) => { point = next },
      read: () => ({ bounds: host.getBounds(), actions: [...actions], expanded: desk.inputOpen() }),
      display: () => screen.getDisplayNearestPoint(point),
      userData: app.getPath('userData'),
      clear: () => { actions.length = 0 },
      restore: () => {
        host.webContents.removeListener('ipc-message', record)
        screen.getCursorScreenPoint = cursor
      },
    }
  })
  try {
    await expect(avatar).toHaveAttribute('aria-expanded', 'false')
    await expect(stage).toHaveAttribute('data-dragging', 'false')
    const box = await avatar.boundingBox()
    if (!box) throw new Error('Desktop portrait has no bounds')
    const mouse = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
    const preferences = path.join(await audit.evaluate(audit => audit.userData), 'preferences.json')
    const mousePointer = 1 // Chromium's CDP mouse uses pointer id 1.
    await desktop.keyboard.press('Tab')
    await expect(avatar).toBeFocused()
    await expect(avatar).toHaveCSS('outline-style', 'solid')
    for (const outcome of ['blur', 'released-capture', 'held-capture', 'escape', 'quick-release'] as const) {
      const origin = (await audit.evaluate(audit => audit.read())).bounds
      const delta = outcome === 'released-capture' ? -112 : 112
      const point = { x: origin.x + mouse.x + delta, y: origin.y + mouse.y + 96 }
      await audit.evaluate((audit, cursor) => audit.move(cursor), { x: origin.x + mouse.x, y: origin.y + mouse.y })
      await audit.evaluate(audit => audit.clear())
      if (outcome === 'quick-release') {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, ...mouse, clickCount: 1 })
        await audit.evaluate((audit, cursor) => audit.move(cursor), point)
        // Change the coordinates of mouseup without ever sending a pressed mousemove.
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, x: mouse.x + 20, y: mouse.y + 12, clickCount: 1 })
      } else {
        await desktop.mouse.move(mouse.x, mouse.y)
        await desktop.mouse.down()
        try {
          await audit.evaluate((audit, cursor) => audit.move(cursor), point)
          await desktop.mouse.move(mouse.x + 20, mouse.y + 12)
          await expect(stage).toHaveAttribute('data-dragging', 'true')
          await expect.poll(async () => {
            const { bounds } = await audit.evaluate(audit => audit.read())
            return Math.max(Math.abs(bounds.x - origin.x - delta), Math.abs(bounds.y - origin.y - 96))
          }, { message: `${outcome} follows the pointer before release` }).toBeLessThanOrEqual(2)

          if (outcome === 'blur') {
            await desktop.evaluate(() => window.dispatchEvent(new FocusEvent('blur')))
          } else if (outcome === 'released-capture') {
            // The browser may report lost capture before delivering a mouseup after a native interruption.
            await avatar.evaluate((node, pointerId) => {
              node.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId, buttons: 0 }))
            }, mousePointer)
          } else if (outcome === 'held-capture') {
            const captured = await avatar.evaluateHandle((node, pointerId) => {
              const events: number[] = []
              node.addEventListener('lostpointercapture', event => {
                if (event instanceof PointerEvent) events.push(event.buttons)
              }, { once: true })
              node.releasePointerCapture(pointerId)
              return events
            }, mousePointer)
            try {
              await desktop.mouse.move(mouse.x + 15, mouse.y + 8)
              await expect.poll(() => captured.evaluate(events => [...events])).toEqual([1])
              expect(await avatar.evaluate((node, id) => node.hasPointerCapture(id), mousePointer)).toBe(true)
            } finally { await captured.dispose() }
          } else {
            await desktop.keyboard.press('Escape')
          }
          // Deliver the trailing trusted click over the portrait, even if its native host has already moved.
          await desktop.mouse.move(mouse.x, mouse.y)
        } finally { await desktop.mouse.up() }
      }

      await expect(stage).toHaveAttribute('data-dragging', 'false')
      await expect(avatar, outcome).not.toBeFocused()
      // This request is processed after the earlier synchronous input messages from the same renderer.
      await desktop.evaluate(async () => { await window.desk.getDraft() })
      const released = await audit.evaluate(audit => audit.read())
      expect(released.actions, outcome).toEqual(['start', outcome === 'escape' ? 'cancel' : 'end'])
      expect(released.expanded, outcome).toBe(false)
      expect(Math.abs(released.bounds.x - origin.x - (outcome === 'escape' ? 0 : delta)), outcome).toBeLessThanOrEqual(2)
      expect(Math.abs(released.bounds.y - origin.y - (outcome === 'escape' ? 0 : 96)), outcome).toBeLessThanOrEqual(2)
      const display = await audit.evaluate(audit => audit.display())
      await expect.poll(() => {
        if (!fs.existsSync(preferences)) return Infinity
        const { last, places } = readPlaces(JSON.parse(fs.readFileSync(preferences, 'utf8')).deskPlaces)
        if (last !== String(display.id)) return Infinity
        const saved = pointOf(places[last], display.workArea)
        return Math.max(Math.abs(saved.x - released.bounds.x - mouse.x), Math.abs(saved.y - released.bounds.y - mouse.y))
      }, { message: `${outcome} leaves the island at its persisted position` }).toBeLessThanOrEqual(2)
    }

    // A new short press still opens the panel after any trailing drag click has been discarded.
    await desktop.mouse.click(mouse.x, mouse.y)
    await expect(avatar).toHaveAttribute('aria-expanded', 'true')
    await expect(avatar).not.toBeFocused()
    await avatar.press('Enter')
    await expect(avatar).toHaveAttribute('aria-expanded', 'false')
  } finally {
    await audit.evaluate(audit => audit.restore())
    await audit.dispose()
    await cdp.detach()
  }
}
