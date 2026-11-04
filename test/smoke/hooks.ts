import type { ElectronApplication, Page } from '@playwright/test'
import type {} from '../../src/main/automation-driver.ts'
import { islandContents } from './electron-window.ts'
import type { SmokeHooks, SmokeModel } from './smoke-kit.ts'

type Runtime = { application: ElectronApplication, page: Page, userData: string, importHome: string, cwd: string, fixtures: string, model: SmokeModel | null }

/** Legacy integration capabilities cross an explicit driver; data and execution remain external. */
export function smokeHooks(runtime: Runtime): SmokeHooks {
  const { application, page } = runtime
  const desk = {
    force: (on: boolean) => application.evaluate((_electron, on) => { globalThis.vivaAutomation!.desk()!.force(on) }, on),
    openInput: () => application.evaluate(() => globalThis.vivaAutomation!.desk()!.openInput()),
    closeInput: () => application.evaluate(() => { globalThis.vivaAutomation!.desk()!.closeInput() }),
    inputOpen: () => application.evaluate(() => globalThis.vivaAutomation!.desk()!.inputOpen()),
    webContents: () => islandContents(application),
  }
  return {
    desk: () => desk,
    model: () => runtime.model,
    userData: runtime.userData, cwd: runtime.cwd, fixtures: runtime.fixtures, importHome: runtime.importHome,
    agentPid: () => application.evaluate(() => globalThis.vivaAutomation!.agentPid()),
    backendPid: () => application.evaluate(() => globalThis.vivaAutomation!.backendPid()),
    async openTasksPage() {
      if (await page.locator('#hub').getAttribute('data-open') !== 'true') await page.locator('#open-profile').click()
      await page.locator('.hub-nav[data-page="tasks"]').click()
    },
    seedShowcase: () => application.evaluate(() => globalThis.vivaAutomation!.seedPrepared({
      title: '设计评审意见',
      ask: '汇总设计稿 v3 的评审意见，列出要改的地方',
      prepareBy: Date.now() + 3_600_000,
      draft: '## 设计稿 v3 评审意见\n\n- 首页卡片间距偏大，建议 16px\n- 后台页的分组标题对比度不足\n\n**要你定的**：深色模式是否默认开启。',
    })),
    scaleFactor: () => application.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor),
    async renderPanel(html, size) {
      const data = await application.evaluate(async ({ BrowserWindow }, options) => {
        const window = new BrowserWindow({ show: false, ...options.size, useContentSize: true, frame: false })
        try {
          await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(options.html)}`)
          await window.webContents.executeJavaScript('Promise.all([...document.images].map(image => image.decode()))')
          return (await window.webContents.capturePage()).toPNG().toString('base64')
        } finally { window.destroy() }
      }, { html, size })
      return Buffer.from(data, 'base64')
    },
  }
}
