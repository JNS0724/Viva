import type { ElectronApplication, Page } from '@playwright/test'
import type { WebContents } from 'electron'
import type { SmokeAppWindow, SmokeContents } from './smoke-kit.ts'

/** Transport only. Scenario code and assertions stay in the test process. */
export async function electronWindow(application: ElectronApplication, page: Page): Promise<SmokeAppWindow> {
  const window = await application.browserWindow(page)
  const contents: SmokeContents = {
    executeJavaScript: code => page.evaluate(code),
    async capturePage(rect) {
      const data = await window.evaluate(async (window, rect) => (await window.webContents.capturePage(rect)).toPNG().toString('base64'), rect)
      const buffer = Buffer.from(data, 'base64')
      return { toPNG: () => buffer }
    },
    sendInputEvent: event => window.evaluate((window, event) => window.webContents.sendInputEvent(event), event),
    getZoomFactor: () => window.evaluate(window => window.webContents.getZoomFactor()),
    setZoomFactor: factor => window.evaluate((window, factor) => { window.webContents.setZoomFactor(factor) }, factor),
    on(_event, listener) {
      page.on('console', message => listener({ level: message.type(), message: message.text() }))
      page.on('pageerror', error => listener({ level: 'error', message: error.message }))
      page.on('crash', () => listener({ level: 'error', message: 'Renderer crashed' }))
    },
  }
  return {
    webContents: contents,
    getSize: () => window.evaluate(window => window.getSize()),
    setSize: (width, height) => window.evaluate((window, size) => { window.setSize(size.width, size.height) }, { width, height }),
    center: () => window.evaluate(window => { window.center() }),
  }
}

/** A desktop island's WebContents lives in the same application but has its own renderer. */
export async function islandContents(application: ElectronApplication): Promise<SmokeContents> {
  const handle = await application.evaluateHandle(() => {
    const contents = globalThis.vivaAutomation?.desk()?.webContents()
    if (!contents) throw new Error('Desktop island has no renderer')
    return contents
  })
  return {
    executeJavaScript: code => handle.evaluate((contents: WebContents, code) => contents.executeJavaScript(code), code),
    async capturePage(rect) {
      const data = await handle.evaluate(async (contents: WebContents, rect) => (await contents.capturePage(rect)).toPNG().toString('base64'), rect)
      const buffer = Buffer.from(data, 'base64')
      return { toPNG: () => buffer }
    },
    sendInputEvent: event => handle.evaluate((contents: WebContents, event) => contents.sendInputEvent(event), event),
    getZoomFactor: () => handle.evaluate((contents: WebContents) => contents.getZoomFactor()),
    setZoomFactor: factor => handle.evaluate((contents: WebContents, factor) => { contents.setZoomFactor(factor) }, factor),
    on(_event, listener) {
      application.on('window', page => {
        page.on('console', message => listener({ level: message.type(), message: message.text() }))
        page.on('pageerror', error => listener({ level: 'error', message: error.message }))
      })
      for (const page of application.windows()) {
        page.on('console', message => listener({ level: message.type(), message: message.text() }))
      }
    },
  }
}
