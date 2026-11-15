import fs from 'node:fs/promises'
import { expect, type TestInfo } from '@playwright/test'
import type { SmokeApplication } from './application.ts'
import { islandContents } from './electron-window.ts'

/** Drive the real floating window, including both sides of IPC and the shared composer draft. */
export async function checkDesktopRedesign(session: SmokeApplication, info: TestInfo, file: { path: string, name: string, size: number }) {
  const { application, page } = session
  const desk = session.hooks.desk()
  const idle = { form: 'idle', tone: 'idle', mood: 'idle', label: '空闲', recent: [] }
  const first = { id: 'approval', title: '运行本地回归验证', status: 'waiting', permission: {
    requestId: 'p1', title: '运行项目的本地测试并检查构建、打包和安装结果', command: 'npm test',
    options: [
      { optionId: 'allow', name: '允许本次运行工作区测试和检查', role: 'primary' },
      { optionId: 'always', name: '总是允许这个工作区运行本地测试', role: 'secondary' },
      { optionId: 'deny', name: '拒绝', role: 'secondary' },
      { optionId: 'never', name: '总是拒绝', role: 'secondary' },
    ],
  } }
  const second = { id: 'sync', title: '准备跨部门同步材料', status: 'waiting', question: {
    questionId: 'q2', id: 'readers', text: '这份周报要发给谁？请根据收件人的职责范围选择。涉及预算和未确认的交付时间，只同步给直接负责人。其他进展、风险和下周待办可以在部门内共享。如果要发给合作团队，请确认是否需要附上精简版，避免转发项目内部记录。',
    options: ['仅项目组成员', '整个部门', '先交给我检查后再发'], skippable: true,
  } }
  const other = { ...first, id: 'other', title: '核对发布配置', permission: { ...first.permission, requestId: 'p3' } }
  const waiting = { ...idle, form: 'waiting', tone: 'waiting', mood: 'confirm', label: '需要你确认', task: first.title,
    taskId: first.id, permission: first.permission, background: { count: 3, waiting: 3, alsoWaiting: 2, items: [first, second, other] } }
  const initial = await page.evaluate(async () => (await window.agent.getDraft()).key)
  const publish = (view: Args<'island:view'>[0]) => page.evaluate(view => window.agent.islandView(view), view)
  const openPanel = (panel: 'background' | 'request') => application.evaluate((_, panel) => globalThis.vivaAutomation!.desk()!.openPanel(panel), panel)
  await publish({ ...idle, target: { key: initial } })
  await desk.force(true)
  try {
    await desk.openInput()
    await expect.poll(() => application.windows().some(window => window.url().endsWith('/desk.html'))).toBe(true)
    const desktop = application.windows().find(window => window.url().endsWith('/desk.html'))!
    await desktop.emulateMedia({ reducedMotion: 'reduce' })
    const contents = await islandContents(application)
    const surface = desktop.locator('.isl-surface')
    const field = desktop.locator('.isl-field')
    const body = surface.locator('.isl-body')
    const take = async (name: string) => {
      await desktop.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const box = await desktop.locator('.isl-anchor').boundingBox()
      const panel = await desktop.locator('.isl-surface:visible, .isl-peek:visible').boundingBox()
      const x = Math.floor(Math.min(box!.x, panel!.x) - 8)
      const y = Math.floor(Math.min(box!.y, panel!.y) - 8)
      const width = Math.ceil(Math.max(box!.x + box!.width, panel!.x + panel!.width) - x + 8)
      const height = Math.ceil(Math.max(box!.y + box!.height, panel!.y + panel!.height) - y + 8)
      await fs.writeFile(info.outputPath(name + '.png'), (await contents.capturePage({ x: Math.max(0, x), y: Math.max(0, y), width, height })).toPNG())
    }
    const outerFocus = () => surface.evaluate(node => getComputedStyle(node).outlineStyle === 'solid' && getComputedStyle(node).outlineWidth === '2px')
    const layout = () => surface.evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }))

    await expect(field).toBeEditable()
    const draft = '把待办事项单独列出来。'
    await field.fill(draft)
    const attachments = Array.from({ length: 10 }, (_, index) =>
      ({ ...file, path: file.path + index, name: '周报资料-' + (index + 1) + '.pdf', size: 1160000 }))
    await desktop.evaluate(async files => {
      const draft = await window.desk.getDraft()
      window.desk.updateDraft({ ...draft, files, sequence: draft.sequence + 1 })
    }, attachments)
    await expect(surface.locator('.isl-file')).toHaveCount(10)
    await field.focus()
    await desktop.keyboard.press('Tab')
    await expect(body).toBeFocused()
    await expect.poll(outerFocus).toBe(true)
    expect(await body.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
    await expect(body.locator('.isl-files')).not.toHaveAttribute('tabindex', '0')
    await take('03-attachment-scroll-focus')
    await desktop.keyboard.press('Tab')
    await expect(surface.locator('.isl-file-x').first()).toBeFocused()
    expect(await outerFocus()).toBe(false)
    await expect(surface.locator('.isl-file-x').first()).toHaveCSS('outline-width', '2px')
    await take('03b-attachment-remove-focus')
    await desktop.evaluate(async file => {
      const draft = await window.desk.getDraft()
      window.desk.updateDraft({ ...draft, files: [file], sequence: draft.sequence + 1 })
    }, file)
    await expect(surface.locator('.isl-file')).toHaveCount(1)

    await publish({ ...idle, target: { key: 'desktop-redesign-switching', blocked: true } })
    await expect(surface.getByRole('status')).toHaveText('正在切换会话，等切换完成再发')
    await expect(surface.getByRole('button', { name: '去设置' })).toHaveCount(0)
    await expect.poll(layout).toEqual({ width: 320, height: 72 })
    await take('05-switching')
    await publish({ ...idle, target: { key: initial, label: '周报同步计划' } })
    await expect(field).toHaveValue(draft)
    await expect(surface.locator('.isl-file-name')).toHaveText(file.name)
    await take('05b-draft-restored')

    await desktop.evaluate(async () => {
      const draft = await window.desk.getDraft()
      window.desk.updateDraft({ ...draft, files: [], sequence: draft.sequence + 1 })
    })
    await expect(surface.locator('.isl-file')).toHaveCount(0)
    await field.focus()
    await desktop.evaluate(() => document.querySelector<HTMLTextAreaElement>('.isl-field')!.setSelectionRange(0, 0))
    const cdp = await desktop.context().newCDPSession(desktop)
    try {
      await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
      await publish({ ...idle, form: 'asking', tone: 'waiting', mood: 'ask', label: '需要你回答',
        question: { ...second.question, text: '这份周报要发给谁？' }, target: { key: initial, working: true } })
      await expect(surface.locator('.isl-notice')).toHaveCount(1)
      await expect(surface.locator('.isl-running')).toHaveCount(0)
      await cdp.send('Input.insertText', { text: '你' })
      await expect(field).toHaveValue('你' + draft)
      await expect(field).toBeFocused()
    } finally { await cdp.detach() }
    await expect.poll(layout).toEqual({ width: 440, height: 152 })
    await take('06-waiting-question-in-input')

    // Constrain only the supplied panel width in the native fixture. The production view and CSS do the layout.
    const widthOverride = await application.evaluateHandle(() => {
      const contents = globalThis.vivaAutomation!.desk()!.webContents()!
      const send = contents.send.bind(contents)
      const width = { value: 364 }
      contents.send = (channel, ...args) => send(channel, ...(channel === 'island:view' ? [{ ...args[0], panelWidth: width.value }] : args))
      return { width, restore: () => { if (!contents.isDestroyed()) contents.send = send } }
    })
    try {
      await publish(waiting)
      await openPanel('background')
      await expect(surface.locator('.isl-bg-approvals')).toHaveCount(2)
      await expect.poll(async () => (await layout()).width).toBe(364)
      await expect(surface.locator('.isl-mini-primary')).toHaveCount(1)
      const primaryRow = surface.locator('.isl-bg-item').first()
      await expect(primaryRow.getByRole('button', { name: '拒绝', exact: true })).toBeInViewport()
      expect(await primaryRow.evaluate(row => {
        const task = row.querySelector('.isl-bg-mid')!.getBoundingClientRect()
        const actions = row.querySelector('.isl-bg-approvals')!.getBoundingClientRect()
        return task.bottom < actions.top && row.scrollWidth === row.clientWidth
      })).toBe(true)
      await take('01b-approval-long-labels')
      const shortApproval = { ...first, permission: { ...first.permission, options: first.permission.options.map((option, index) =>
        ({ ...option, name: ['允许', '总是允许', '拒绝', '总是拒绝'][index] })) } }
      const shortView = { ...waiting, permission: shortApproval.permission, background: { count: 3, waiting: 2, alsoWaiting: 1,
        items: [shortApproval, second, { id: 'running', title: '整理本周项目资料', status: 'running', now: '核对原始记录', startedAt: Date.now() - 65_000 }] } }
      await publish(shortView)
      await expect(primaryRow.getByRole('button', { name: '允许', exact: true })).toBeVisible()
      await take('01-approval')
      await widthOverride.evaluate(override => { override.width.value = 440 })
      await publish({ ...shortView, background: { count: 2, waiting: 2, alsoWaiting: 1, items: [shortApproval, second] } })
      await expect.poll(async () => (await layout()).width).toBe(440)
      await take('07-background-question')
      const answer = surface.getByRole('button', { name: '去回答', exact: true })
      await answer.focus()
      await desktop.keyboard.press('Enter')
      await expect(surface.locator('.isl-surface-head')).toContainText(second.title)
      await expect(surface.locator('.isl-title')).toHaveText(second.question.text)
      await expect(body).toBeFocused()
      await expect.poll(outerFocus).toBe(true)
      await take('02-question-scroll-focus')
      await desktop.keyboard.press('Tab')
      await expect(surface.getByRole('button', { name: '仅项目组成员', exact: true })).toBeFocused()
      await expect.poll(outerFocus).toBe(false)
      await take('02b-question-choice-focus')
      await publish(waiting)
      await expect(surface.locator('.isl-title')).toHaveText(second.question.text)
      await publish({ ...waiting, background: { ...waiting.background, items: [first, other] } })
      await expect(surface.locator('.isl-title')).toHaveText(first.permission.title)
    } finally {
      await widthOverride.evaluate(override => override.restore())
      await widthOverride.dispose()
    }
    await desk.closeInput()
    const peek = desktop.locator('.isl-peek')
    await expect(peek.locator('.isl-bg')).toContainText('+2')
    await expect(peek).toHaveCSS('height', '72px')
    await expect(peek.locator('.isl-more')).toHaveCSS('white-space', 'nowrap')
    await take('08-pending-count')
    await openPanel('request')
    await expect(surface.locator('.isl-surface-head')).toContainText(first.title)
    await take('08b-pending-expanded')
    await publish({ ...idle, form: 'pending', tone: 'pending', label: '未连接', detail: '需要配置模型' })
    await desk.openInput()
    await expect(surface.getByRole('button', { name: '去设置' })).toBeVisible()
    await expect(desktop.locator('.isl')).toHaveAttribute('data-signal', 'offline')
    await expect(field).toHaveCount(0)
    await take('04-offline')
  } finally {
    await desk.closeInput()
    await desk.force(false)
  }
}
