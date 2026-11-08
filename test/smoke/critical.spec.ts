import { test, expect } from './fixtures.ts'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { checkIslandLayouts } from './island-layout.ts'

type MaidModule = typeof import('../../src/renderer/view/maid.ts')
declare global { interface Window { vivaDraftAudit?: Array<{ key: string, version: number, sequence: number, epoch: number, owner: string, chars: number, files: number, images: number }> } }

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
    await desktop.getByRole('button', { name: '去设置', exact: true }).click()
    await expect(page.locator('#settings-root')).toBeVisible()
    await expect.poll(() => desk.inputOpen()).toBe(false)
  } finally { await desk.force(false) }
})

test('a real embedded agent answers and history survives a restart', async ({ scenario }) => {
  const run = await scenario({ phase: 'memory', bridge: 'real' })
  let session = await run.start('send')
  await session.page.locator('#composer-input').fill('你好，外部冒烟验证')
  await session.page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(session.page.locator('.msg-agent .msg-text').last()).toContainText('外部冒烟验证')
  await expect(session.page.locator('#send-btn')).toHaveAttribute('data-busy', 'false')
  session = await run.start('restart')
  await expect(session.page.locator('.msg-user').last()).toContainText('外部冒烟验证')
  await expect(session.page.locator('.msg-agent .msg-text').last()).toContainText('外部冒烟验证')
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
