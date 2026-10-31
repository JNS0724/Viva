import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SmokeHarness } from '../../src/main/smoke-entry.ts'
import { runSmoke } from './smoke.ts'
import { seedTimeline } from './smoke-timeline.ts'
import { seedPerf } from './smoke-perf.ts'

/** Compiled by build:smoke, excluded from installers, and lent to installed-app acceptance explicitly. */
export const smokeHarness: SmokeHarness = {
  seed(phase, userData) {
    if (phase === 'timeline') seedTimeline(userData)
    else if (phase === 'perf') seedPerf(userData)
  },
  async startModel({ phase, fixtures, port }) {
    const { startFakeLlm } = await import(pathToFileURL(path.join(fixtures, 'fake-llm.js')).href)
    const decideFirst = phase === 'showcase'
      ? (await import(pathToFileURL(path.join(fixtures, 'showcase-llm.js')).href)).showcaseDecide
      : null
    return startFakeLlm({ port, decideFirst })
  },
  run(win, config, quit, host) {
    return runSmoke(win, config, quit, {
      ...host,
      seedSuggestion: () => {
        host.sources()?.db.save('smoke-mail', [{ id: 'm1', at: Date.now(), from: '[发件人]', title: '合同明天到期', text: '请今天内回复确认是否续签' }], 'c1')
        host.sources()?.db.markJudged([{ source: 'smoke-mail', id: 'm1' }])
        host.followups()?.store.addSuggestion({ source: 'smoke-mail', messageId: 'm1', sender: '[发件人]', title: '合同续签', ask: '起草回复，确认续签', why: '明天到期', remindAt: null })
        host.followups()?.notifier.refresh()
      },
      judgeMessages: () => host.followups()?.judge?.run(new AbortController().signal) ?? Promise.resolve(null),
      seedMail: () => {
        const now = Date.now()
        const mails = [
          { id: 'm1', at: now - 17 * 60_000, from: '法务部', title: '服务合同明天到期，请确认是否续签', text: '您好，贵司与供应商的年度服务合同将于明天到期。如需续签，请在今天下班前回复确认，并附上采购部的审批单。' },
          { id: 'm2', at: now - 34 * 60_000, from: '王五', title: '周会纪要（10/24）', text: '本周对账系统按计划推进，退款回归测试由李四负责，周三前补齐。' },
        ]
        host.sources()?.db.save('company-mail', mails, '2')
        host.sources()?.db.markJudged(mails.map(mail => ({ source: 'company-mail', id: mail.id })))
        host.followups()?.store.addSuggestion({ source: 'company-mail', messageId: 'm1', sender: '法务部', title: '合同续签', ask: '起草续签确认的回复，发不发由你', why: '明天到期，要你回复确认', remindAt: new Date(now).setHours(24 + 10, 0, 0, 0) })
        host.followups()?.notifier.refresh()
      },
    })
  },
}
