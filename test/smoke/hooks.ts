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
    async openTasksPage() {
      if (await page.locator('#hub').getAttribute('data-open') !== 'true') await page.locator('#open-profile').click()
      await page.locator('.hub-nav[data-page="tasks"]').click()
    },
    pickSourceFolder: directory => application.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
    }, directory),
    seedSuggestion: () => application.evaluate(() => {
      const driver = globalThis.vivaAutomation!
      driver.sources()?.db.save('smoke-mail', [{ id: 'm1', at: Date.now(), from: '[发件人]', title: '合同明天到期', text: '请今天内回复确认是否续签' }], 'c1')
      driver.sources()?.db.markJudged([{ source: 'smoke-mail', id: 'm1' }])
      driver.followups()?.store.addSuggestion({ source: 'smoke-mail', messageId: 'm1', sender: '[发件人]', title: '合同续签', ask: '起草回复，确认续签', why: '明天到期', remindAt: null })
      driver.followups()?.notifier.refresh()
    }),
    seedShowcase: () => application.evaluate(() => {
      const driver = globalThis.vivaAutomation!
      const followups = driver.followups()
      if (!followups) throw new Error('Followups service is unavailable')
      const now = Date.now()
      const review = followups.store.add({ title: '设计评审意见', ask: '汇总设计稿 v3 的评审意见，列出要改的地方', origin: { kind: 'manual' }, prepareBy: now + 3_600_000 })
      followups.store.moveStatus(review.id, 'scheduled', 'preparing')
      followups.store.finishPreparing(review.id, '## 设计稿 v3 评审意见\n\n- 首页卡片间距偏大，建议 16px\n- 后台页的分组标题对比度不足\n\n**要你定的**：深色模式是否默认开启。', [])
      const mails = [
        { id: 'm1', at: now - 17 * 60_000, from: '法务部', title: '服务合同明天到期，请确认是否续签', text: '您好，贵司与供应商的年度服务合同将于明天到期。如需续签，请在今天下班前回复确认，并附上采购部的审批单。' },
        { id: 'm2', at: now - 34 * 60_000, from: '王五', title: '周会纪要（10/24）', text: '本周对账系统按计划推进，退款回归测试由李四负责，周三前补齐。' },
      ]
      driver.sources()?.db.save('company-mail', mails, '2')
      driver.sources()?.db.markJudged(mails.map(mail => ({ source: 'company-mail', id: mail.id })))
      followups.store.addSuggestion({ source: 'company-mail', messageId: 'm1', sender: '法务部', title: '合同续签', ask: '起草续签确认的回复，发不发由你', why: '明天到期，要你回复确认', remindAt: new Date(now).setHours(34, 0, 0, 0) })
      followups.notifier.refresh()
    }),
    judgeMessages: () => application.evaluate(async () => globalThis.vivaAutomation!.followups()?.judge?.run(new AbortController().signal) ?? null),
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
