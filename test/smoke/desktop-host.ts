import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { DESK_SIZE, FIXED_DESK_HOST } from '../../src/shell/desk-place.ts'
import fs from 'node:fs'

/** Reuse the startup instance to cover the native Windows host, real IPC and queued renderer placement. */
export async function checkDesktopHost(application: ElectronApplication, desktop: Page, info: TestInfo): Promise<void> {
  if (!FIXED_DESK_HOST) return
  const result = await application.evaluate(async ({ BrowserWindow, screen }, size) => {
    const desk = globalThis.vivaAutomation!.desk()!
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/desk.html'))!
    type Geometry = { kind: 'rect', x: number, y: number, width: number, height: number, version: number, ready: boolean }
    const reports: Geometry[] = []
    const bounds: Electron.Rectangle[] = []
    const requested: Array<Partial<Electron.Rectangle>> = []
    const originalCursor = screen.getCursorScreenPoint.bind(screen)
    const originalBounds = window.setBounds.bind(window)
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
    window.setBounds = (next, animate) => { requested.push({ ...next }); originalBounds(next, animate); bounds.push(window.getBounds()) }
    screen.getCursorScreenPoint = () => pointer
    const corners = [], drags = []
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
        for (let step = 1; step <= 10; step++) {
          pointer = { x: from.x + 9 * step, y: from.y + 8 * step }
          desk.dragMove()
          await wait(16)
        }
        const beforeRelease = window.getBounds()
        beforeVersion = version()
        desk.endDrag(cancel)
        await settled(beforeVersion)
        drags.push({ cancel, expandedBefore, origin, beforeRelease, after: window.getBounds(), expandedAfter: desk.inputOpen() })
      }
      return { corners, drags, reports, bounds, requested, scaleFactor: screen.getPrimaryDisplay().scaleFactor }
    } finally {
      screen.getCursorScreenPoint = originalCursor
      window.setBounds = originalBounds
      window.webContents.removeListener('ipc-message', record)
      desk.closeInput()
      desk.resetPlace()
    }
  }, DESK_SIZE)
  const resultFile = info.outputPath('windows-desktop-host.json')
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2))
  await info.attach('windows-desktop-host', { path: resultFile, contentType: 'application/json' })
  for (const corner of result.corners) expect(corner.contained, corner.corner).toBe(true)
  expect(result.bounds.length).toBeGreaterThan(10)
  for (const bounds of result.requested) {
    expect(bounds.width).toBe(DESK_SIZE.width)
    expect(bounds.height).toBe(DESK_SIZE.height)
  }
  // Windows rounds each native edge separately at fractional DPI, including negative host origins.
  const edgeRounding = Math.ceil(2 / result.scaleFactor)
  for (const bounds of result.bounds) {
    expect(Math.abs(bounds.width - DESK_SIZE.width)).toBeLessThanOrEqual(edgeRounding)
    expect(Math.abs(bounds.height - DESK_SIZE.height)).toBeLessThanOrEqual(edgeRounding)
  }
  for (const report of result.reports) {
    expect(Math.abs(report.x - (DESK_SIZE.width / 2 - 40)), JSON.stringify(report)).toBeLessThanOrEqual(1)
    expect(Math.abs(report.y - (DESK_SIZE.height / 2 - 40)), JSON.stringify(report)).toBeLessThanOrEqual(1)
  }
  for (const drag of result.drags) {
    const expected = drag.cancel ? drag.origin : drag.beforeRelease
    expect(Math.abs(drag.after.x - expected.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(drag.after.y - expected.y)).toBeLessThanOrEqual(1)
    expect(drag.expandedBefore).toBe(true)
    expect(drag.expandedAfter).toBe(drag.cancel)
  }
  await desktop.screenshot({ path: info.outputPath('windows-fixed-desktop-host.png') })
}
