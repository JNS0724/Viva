import { test, expect } from './fixtures.ts'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { checkIslandLayouts } from './island-layout.ts'
import { checkDesktopHost } from './desktop-host.ts'
import { checkStreamingDrawer } from './drawer-interaction.ts'
import { checkStreamingNavigation } from './ui-retention.ts'

type MaidModule = typeof import('../../src/renderer/view/maid.ts')
declare global { interface Window { vivaDraftAudit?: Array<{ key: string, version: number, sequence: number, epoch: number, owner: string, chars: number, files: number, images: number }> } }

test('MCP import menu stays inside its sidebar and cancelling an edit restores the saved server', async ({ scenario }, info) => {
  const run = await scenario({ phase: 'setup', bridge: 'real' })
  const serverFile = path.join(run.profile.userData, 'mcp-servers.json')
  const saved = JSON.stringify({ version: 1, servers: [{ name: 'cancel-demo', type: 'stdio', command: 'node', args: ['original'], secrets: null, missing: [] }] })
  fs.writeFileSync(serverFile, saved)
  const session = await run.start('mcp-controls')
  const { page } = session
  await page.locator('#open-profile').click()
  await page.locator('.hub-nav[data-page="capabilities"]').click()
  await page.locator('.cap-tabs [data-tab="mcp"]').click()
  await expect(page.locator('.cap-row[data-name="cancel-demo"]')).toBeVisible()
  const mainWindow = await session.application.browserWindow(page)
  const bounds = []
  for (const width of [1360, 880, 720]) {
    await mainWindow.evaluate((window, width) => window.setSize(width, 860), width)
    await page.locator('.import-btn').click()
    await expect(page.locator('.import-menu')).toBeVisible()
    const metrics = await page.locator('.import-menu').evaluate(menu => {
      const sidebar = menu.closest('.cap-side')!
      const box = menu.getBoundingClientRect(), side = sidebar.getBoundingClientRect()
      const location = menu.querySelector('.workdir-item-name')!
      return { viewport: innerWidth, menuLeft: box.left, menuRight: box.right,
        sideLeft: side.left, sideRight: side.left + sidebar.clientLeft + sidebar.clientWidth,
        leftVisible: Boolean(document.elementFromPoint(box.left + 2, box.top + 12)?.closest('.import-menu')),
        locationSingleLine: location.getBoundingClientRect().height < parseFloat(getComputedStyle(location).fontSize) * 1.8 }
    })
    bounds.push(metrics)
    await page.screenshot({ path: info.outputPath(`mcp-import-menu-${width}.png`) })
    expect.soft(metrics.menuLeft, `left edge at ${width}px`).toBeGreaterThanOrEqual(metrics.sideLeft)
    expect.soft(metrics.menuRight, `right edge at ${width}px`).toBeLessThanOrEqual(metrics.sideRight)
    expect.soft(metrics.leftVisible, `menu is hit-testable at ${width}px`).toBe(true)
    expect.soft(metrics.locationSingleLine, `location label at ${width}px`).toBe(true)
    await page.locator('.import-scrim').click({ position: { x: 8, y: 400 } })
    await expect(page.locator('.import-menu')).toHaveCount(0)
  }
  await info.attach('mcp-menu-bounds', { body: JSON.stringify(bounds, null, 2), contentType: 'application/json' })
  await mainWindow.evaluate(window => window.setSize(1360, 860))
  const details = page.locator('.cap-card[data-name="cancel-demo"]')
  await details.locator('.ext-actions button').first().click()
  const form = page.locator('.ext-edit')
  await expect(form).toBeVisible()
  await form.locator('[name="mcp-command"]').fill('discard-this-command')
  await form.getByRole('button', { name: '取消', exact: true }).click()
  await expect(form).toHaveCount(0)
  await expect(details).toContainText('node original')
  expect(fs.readFileSync(serverFile, 'utf8')).toBe(saved)
  await details.locator('.ext-actions button').first().click()
  await expect(form.locator('[name="mcp-command"]')).toHaveValue('node')
  await form.getByRole('button', { name: '取消', exact: true }).click()
  await expect(form).toHaveCount(0)
  expect(fs.readFileSync(serverFile, 'utf8')).toBe(saved)
  await page.screenshot({ path: info.outputPath('mcp-edit-cancelled.png') })
})

test('desktop drafts retain text, real images and files through collapse and window recreation, then return editing to the main window', async ({ scenario }, info) => {
  const run = await scenario({ phase: 'memory', bridge: 'real' })
  const session = await run.start('shared-draft')
  const { page } = session, desk = session.hooks.desk()
  await page.evaluate(() => {
    window.vivaDraftAudit = []
    window.agent.onDraft(draft => window.vivaDraftAudit!.push({ key: draft.key, version: draft.version, sequence: draft.sequence, epoch: draft.epoch, owner: draft.owner, chars: draft.text.length, files: draft.files.length, images: draft.images.length }))
  })
  const text = '保留这份跨窗口草稿'
  const file = { path: path.join(run.profile.workspace, 'draft-note.txt'), name: 'draft-note.txt', size: 4 }
  fs.writeFileSync(file.path, 'demo')
  await page.locator('#composer-input').fill(text)
  await expect.poll(() => page.evaluate(async () => (await window.agent.getDraft()).text)).toBe(text)
  await desk.force(true)
  try {
    await desk.openInput()
    await expect.poll(() => session.application.windows().some(window => window.url().endsWith('/desk.html'))).toBe(true)
    let desktop = session.application.windows().find(window => window.url().endsWith('/desk.html'))!
    await expect(desktop.locator('.isl-field')).toHaveValue(text)
    const before = await desktop.locator('.isl-anchor').boundingBox()
    await desktop.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16
      canvas.getContext('2d')!.fillRect(0, 0, 16, 16)
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'))
      const data = new DataTransfer(); data.items.add(new File([blob], 'draft.png', { type: 'image/png' }))
      document.querySelector('.isl-field')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
    })
    await expect(desktop.locator('.isl-image')).toHaveCount(1)
    await desktop.evaluate(async file => {
      const draft = await window.desk.getDraft()
      window.desk.updateDraft({ ...draft, sequence: draft.sequence + 1, files: [file] })
    }, file)
    await expect(desktop.locator('.isl-file')).toHaveCount(2)
    await desktop.locator('.isl-field').press('Escape')
    await expect(desktop.locator('.isl')).toHaveAttribute('data-open', 'false')
    const folded = await desktop.locator('.isl-anchor').boundingBox()
    expect(Math.abs(before!.x - folded!.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(before!.y - folded!.y)).toBeLessThanOrEqual(1)
    await desktop.locator('.isl-anchor').click()
    await expect(desktop.locator('.isl-field')).toHaveValue(text)
    await expect(desktop.locator('.isl-file')).toHaveCount(2)
    await desktop.screenshot({ path: info.outputPath('shared-desktop-draft.png') })
    await desktop.getByRole('button', { name: '打开 Viva', exact: true }).click()
    await expect(page.locator('#composer-input')).toHaveValue(text)
    await expect(page.locator('.composer-shared-files .isl-file')).toHaveCount(1)
    await expect(page.locator('.draft-pic')).toHaveCount(1)
    await page.screenshot({ path: info.outputPath('shared-main-draft.png') })
    await desk.force(true); await desk.openInput()
    await expect.poll(() => session.application.windows().some(window => window.url().endsWith('/desk.html'))).toBe(true)
    desktop = session.application.windows().find(window => window.url().endsWith('/desk.html'))!
    await expect(desktop.locator('.isl-field')).toHaveValue(text)
    await expect(desktop.locator('.isl-file')).toHaveCount(2)
    await desktop.locator('.isl-image .isl-file-x').click()
    await expect(desktop.locator('.isl-file')).toHaveCount(1)
    await desktop.locator('.isl-field').fill('')
    await desktop.locator('.isl-field').press('Enter')
    await expect(page.locator('.msg-user').last()).toContainText(file.name)
    await expect(desktop.locator('.isl')).toHaveAttribute('data-open', 'false')
    await expect.poll(() => page.evaluate(async () => (await window.agent.getDraft()).text)).toBe('')
  } finally {
    await info.attach('shared-draft-events', { body: JSON.stringify(await page.evaluate(() => window.vivaDraftAudit), null, 2), contentType: 'application/json' })
    await desk.force(false)
  }
  await page.locator('#composer-input').fill('主窗口继续发送')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('.msg-user').last()).toContainText('主窗口继续发送')
  await expect(page.locator('#send-btn')).toHaveAttribute('data-busy', 'false')
  const topicDraft = '返回这个话题后恢复文字与附件'
  await page.locator('#composer-input').fill(topicDraft)
  const originalKey = await page.evaluate(async () => (await window.agent.getDraft()).key)
  await page.locator('#ctx-area .ctx-new').click()
  await expect(page.locator('#send-btn')).toBeEnabled()
  await expect.poll(() => page.evaluate(async () => (await window.agent.getDraft()).key)).not.toBe(originalKey)
  await page.locator('#composer-input').fill('另一个话题自己的草稿')
  await page.locator('#earlier .topic-start .topic-back').click()
  await expect.poll(() => page.evaluate(async () => (await window.agent.getDraft()).key)).toBe(originalKey)
  await expect(page.locator('#composer-input')).toHaveValue(topicDraft)
  await page.reload()
  await expect(page.locator('#composer-input')).toHaveValue(topicDraft)
  await expect.poll(() => page.evaluate(async () => (await window.agent.getDraft()).key)).toBe(originalKey)
  // Use the normal close-to-tray lifecycle so Open Viva really retires the reading renderer.
  await session.application.evaluate(() => globalThis.vivaAutomation!.desk()!.setEnabled(true))
  try {
    const mainWindow = await session.application.browserWindow(page)
    await mainWindow.evaluate(window => window.close())
    await desk.openInput()
    await expect.poll(() => session.application.windows().some(window => window.url().endsWith('/desk.html'))).toBe(true)
    const readingDesktop = session.application.windows().find(window => window.url().endsWith('/desk.html'))!
    await expect(readingDesktop.locator('.isl-field')).toHaveValue(topicDraft)
    await readingDesktop.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 16; canvas.height = 16
      canvas.getContext('2d')!.fillRect(0, 0, 16, 16)
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'))
      const png = new Uint8Array(await blob.arrayBuffer())
      const data = new DataTransfer()
      for (const size of [20 * 1024 * 1024 - 1, 20 * 1024 * 1024]) {
        const bytes = new Uint8Array(size)
        bytes.set(png)
        data.items.add(new File([bytes], `large-${size}.png`, { type: 'image/png' }))
      }
      const open = [...document.querySelectorAll<HTMLButtonElement>('.isl-surface-head button')].find(button => button.textContent === '打开 Viva')!
      document.querySelector('.isl-field')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
      setTimeout(() => open.click(), 0)
    })
    await expect.poll(() => page.evaluate(async () => (await window.agent.getDraft()).images.map(image => image.size))).toEqual([20 * 1024 * 1024 - 1, 20 * 1024 * 1024])
    await expect(page.locator('#composer-input')).toHaveValue(topicDraft)
    await expect(page.locator('.draft-pic')).toHaveCount(2)
    await expect.poll(() => readingDesktop.isClosed()).toBe(true)
    const draft = await page.evaluate(() => window.agent.getDraft())
    expect(draft.key).toBe(originalKey)
    expect(draft.owner).toBe('main')
    expect(draft.error).toBeNull()
    await info.attach('large-image-handoff-draft', { body: JSON.stringify(draft, null, 2), contentType: 'application/json' })
  } finally {
    await session.application.evaluate(() => globalThis.vivaAutomation!.desk()!.setEnabled(false))
  }
})

test('fresh app opens usable settings without a model', async ({ scenario }, info) => {
  const run = await scenario({ phase: 'setup', bridge: 'real' })
  const session = await run.start('startup')
  const { page } = session
  await expect(page.locator('#composer-input')).toBeDisabled()
  await page.getByRole('button', { name: '回顾、后台、关于你和设置', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.locator('#settings-root')).toBeVisible()
  await checkIslandLayouts(page, info)
  const desk = session.hooks.desk()
  await desk.force(true)
  try {
    await desk.openInput()
    await expect.poll(() => session.application.windows().some(window => window.url().endsWith('/desk.html'))).toBe(true)
    const desktop = session.application.windows().find(window => window.url().endsWith('/desk.html'))!
    await checkDesktopHost(session.application, desktop, info)
    await desk.openInput()
    await desktop.getByRole('button', { name: '去设置', exact: true }).click()
    await expect(page.locator('#settings-root')).toBeVisible()
    await expect.poll(() => desk.inputOpen()).toBe(false)
  } finally { await desk.force(false) }
})

test('a real embedded agent answers and history survives a restart', async ({ scenario }, info) => {
  const run = await scenario({ phase: 'memory', bridge: 'real' })
  let session = await run.start('send')
  await session.page.locator('#composer-input').fill('你好，外部冒烟验证')
  await session.page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(session.page.locator('.msg-agent .msg-text').last()).toContainText('外部冒烟验证')
  await expect(session.page.locator('#send-btn')).toHaveAttribute('data-busy', 'false')
  // A desktop-island reply must finish while the ordinary conversation window remains closed to the tray.
  await session.application.evaluate(() => globalThis.vivaAutomation!.desk()!.setEnabled(true))
  const mainWindow = await session.application.browserWindow(session.page)
  try {
    await mainWindow.evaluate(window => window.close())
    await session.hooks.desk().openInput()
    await expect.poll(() => session.application.windows().some(window => window.url().endsWith('/desk.html'))).toBe(true)
    const desktop = session.application.windows().find(window => window.url().endsWith('/desk.html'))!
    const longIslandTask = '桌面岛隐藏窗口回复验证\n\n' + Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 项：逐步核对合成数据，最后给出完整总结。`).join('\n\n')
    await desktop.locator('.isl-field').fill(longIslandTask)
    await desktop.evaluate(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))
    })
    await desktop.locator('.isl-send').click()
    await expect(session.page.locator('.msg-user').last()).toContainText('桌面岛隐藏窗口回复验证')
    await expect(desktop.locator('.isl')).toHaveAttribute('data-form', 'done')
    expect(await mainWindow.evaluate(window => window.isVisible())).toBe(false)
    await mainWindow.evaluate(window => window.show())
    await expect(session.page.locator('.msg-agent .msg-text').last()).toContainText('桌面岛隐藏窗口回复验证')
    await expect.poll(() => session.page.locator('#scroll').evaluate(scroll => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight), {
      message: 'opening a desktop-island reply reveals the latest output',
    }).toBeLessThanOrEqual(32)
    await expect(session.page.locator('#send-btn')).toHaveAttribute('data-busy', 'false')
  } finally {
    await mainWindow.evaluate(window => window.show())
    await session.application.evaluate(() => globalThis.vivaAutomation!.desk()!.setEnabled(false))
  }
  session = await run.start('restart')
  await expect(session.page.locator('.msg-user').last()).toContainText('桌面岛隐藏窗口回复验证')
  await expect(session.page.locator('.msg-agent .msg-text').last()).toContainText('桌面岛隐藏窗口回复验证')
  await checkStreamingDrawer(session, info)
  await checkStreamingNavigation(session, info)
})

test('centred chat avatars and the folded desktop island animate without restarting on refresh', async ({ scenario }, info) => {
  const run = await scenario({ phase: 'memory', bridge: 'real' })
  const session = await run.start('animated-portraits')
  const { page } = session
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.locator('#composer-input').fill('你好，头像动图验证')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('#send-btn')).toHaveAttribute('data-busy', 'false')
  const avatar = page.locator('.msg-agent .maid-avatar .maid-image').last()
  await expect(avatar).toBeVisible()
  await expect(avatar).toHaveAttribute('src', /\/maid\/avatars\/\w+-motion\.webp$/)
  await expect(avatar).toHaveCSS('width', '48px')
  await expect(avatar).toHaveCSS('left', '0px')
  const frames = new Set<string>()
  await expect.poll(async () => {
    frames.add(createHash('sha256').update(await avatar.screenshot({ animations: 'allow' })).digest('hex'))
    return frames.size
  }, { message: 'the rendered chat avatar advances beyond its first frame' }).toBeGreaterThan(1)
  await page.screenshot({ path: info.outputPath('animated-chat.png') })

  const desk = session.hooks.desk()
  await desk.force(true)
  try {
    await expect.poll(() => session.application.windows().some(window => window.url().endsWith('/desk.html'))).toBe(true)
    const desktop = session.application.windows().find(window => window.url().endsWith('/desk.html'))!
    await desktop.emulateMedia({ reducedMotion: 'no-preference' })
    await expect(desktop.locator('.isl-anchor .maid-image')).toBeVisible()
    const coach = desktop.locator('.isl[data-form="coach"] .isl-btn-blue')
    if (await coach.isVisible()) await coach.click()
    await expect(desktop.locator('.isl')).toHaveAttribute('data-open', 'false')
    await expect.poll(() => desktop.locator('.isl').evaluate(element => {
      const portrait = element.querySelector<HTMLElement>('.maid')!
      const image = portrait.querySelector<HTMLImageElement>('img')!
      return portrait.dataset.framing === 'whole' && /-motion\.webp$/.test(image.src)
    })).toBe(true)
    await desktop.screenshot({ path: info.outputPath('animated-desktop.png') })
    await desktop.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(() => desktop.locator('.isl-anchor .maid-image').evaluate((image: HTMLImageElement) => image.currentSrc)).toMatch(/\/[a-z]+\.webp$/)
    await desktop.emulateMedia({ reducedMotion: 'no-preference' })
    await expect.poll(() => desktop.locator('.isl-anchor .maid-image').evaluate((image: HTMLImageElement) => image.currentSrc)).toMatch(/-motion\.webp$/)
  } finally { await desk.force(false) }

  // Use the production renderer for all states, including a hover redraw with the same portrait.
  const stateGallery = await page.evaluate(async () => {
    const { maidFor, MAID_MOODS } = await import(new URL('./view/maid.js', location.href).href) as MaidModule
    const { createIsland } = await import(new URL('./view/island-dom.js', location.href).href) as typeof import('../../src/renderer/view/island-dom.ts')
    const gallery = document.createElement('section')
    gallery.id = 'portrait-gallery'
    gallery.style.cssText = 'position:fixed;inset:60px 16px 16px;z-index:100;background:var(--bg);padding:20px;display:flex;gap:16px;flex-wrap:wrap;align-content:start;overflow:auto'
    const cache: Parameters<MaidModule['maidFor']>[0] = new Map()
    for (const mood of MAID_MOODS.filter(mood => mood !== 'listening')) {
      const cell = document.createElement('div')
      cell.style.cssText = 'display:flex;flex-direction:column;gap:8px;align-items:center'
      cell.append(maidFor(cache, `whole-${mood}`, mood, { size: 72, moving: true }), maidFor(cache, `face-${mood}`, mood, { size: 48, framing: 'face', moving: true }))
      const caption = document.createElement('span')
      caption.textContent = mood
      cell.append(caption)
      gallery.append(cell)
    }
    const island = createIsland('desk', () => {})
    island.update({ form: 'mini', mood: 'idle', tone: 'quiet', label: '', recent: [] })
    gallery.append(island.el)
    document.body.append(gallery)
    await Promise.all([...gallery.querySelectorAll('img')].map(image => image.decode()))
    const face = island.el.querySelector('.isl-anchor')!
    let replacements = 0
    const observer = new MutationObserver(records => { replacements += records.length })
    observer.observe(face, { childList: true })
    island.setPointer(true)
    await new Promise(resolve => setTimeout(resolve, 450))
    const hovered = face.firstChild
    island.update({ form: 'mini', mood: 'idle', tone: 'quiet', label: '', recent: [] }, { now: Date.now() + 1000 })
    observer.disconnect()
    return { loaded: [...gallery.querySelectorAll('img')].every(image => image.naturalWidth > 0), count: gallery.querySelectorAll('img').length,
      replacements, retained: face.firstChild === hovered, folded: island.el.dataset.open, hovered: island.el.dataset.hover === 'true' }
  })
  expect(stateGallery).toEqual({ loaded: true, count: 21, replacements: 0, retained: true, folded: 'false', hovered: true })
  // Wait beyond the old one-shot greeting, then check the actual compressed
  // half-body artwork still advances in the production renderer.
  await page.waitForTimeout(2100)
  for (const mood of ['greeting', 'done']) {
    const image = page.locator(`#portrait-gallery .maid[data-mood="${mood}"][data-framing="whole"] .maid-image`)
    const samples = new Set<string>()
    await expect.poll(async () => {
      samples.add(createHash('sha256').update(await image.screenshot({ animations: 'allow' })).digest('hex'))
      return samples.size
    }, { message: `${mood} keeps animating after the original greeting would have stopped` }).toBeGreaterThan(1)
  }
  await page.screenshot({ path: info.outputPath('all-animated-states.png') })
  await page.locator('#portrait-gallery').evaluate(gallery => gallery.remove())

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(() => avatar.evaluate((image: HTMLImageElement) => image.currentSrc)).toMatch(/\/avatars\/[a-z]+\.webp$/)
  const stills = await page.evaluate(async () => {
    const { maidFor, MAID_MOODS } = await import(new URL('./view/maid.js', location.href).href) as MaidModule
    const cache: Parameters<MaidModule['maidFor']>[0] = new Map()
    const gallery = document.createElement('div')
    const images = MAID_MOODS.flatMap(mood => (['whole', 'face'] as const).map(framing => {
      const el = maidFor(cache, `${framing}-${mood}`, mood, { size: 48, framing, moving: true })
      gallery.append(el)
      return el.querySelector('img')!
    }))
    document.body.append(gallery)
    await Promise.all(images.map(image => image.decode()))
    const sources = images.map(image => image.currentSrc)
    gallery.remove()
    return sources
  })
  expect(stills).toHaveLength(22)
  expect(stills.every(source => /\/[a-z]+\.webp$/.test(source))).toBe(true)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect.poll(() => avatar.evaluate((image: HTMLImageElement) => image.currentSrc)).toMatch(/-motion\.webp$/)
})
