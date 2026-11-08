import { test, expect } from './fixtures.ts'
import { createHash } from 'node:crypto'
import { checkIslandLayouts } from './island-layout.ts'

type MaidModule = typeof import('../../src/renderer/view/maid.ts')

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
    await expect(desktop.locator('.isl-face .maid-image')).toBeVisible()
    const coach = desktop.locator('.isl[data-form="coach"] .isl-btn-blue')
    if (await coach.isVisible()) await coach.click()
    await expect(desktop.locator('.isl')).toHaveAttribute('data-open', 'false')
    await expect.poll(() => desktop.locator('.isl').evaluate(element => {
      const portrait = element.querySelector<HTMLElement>('.maid')!
      const image = portrait.querySelector<HTMLImageElement>('img')!
      return portrait.dataset.framing === (element.dataset.layout === 'rest' ? 'whole' : 'face') && /-motion\.webp$/.test(image.src)
    })).toBe(true)
    await desktop.screenshot({ path: info.outputPath('animated-desktop.png') })
    await desktop.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(() => desktop.locator('.isl-face .maid-image').evaluate((image: HTMLImageElement) => image.currentSrc)).toMatch(/\/[a-z]+\.webp$/)
    await desktop.emulateMedia({ reducedMotion: 'no-preference' })
    await expect.poll(() => desktop.locator('.isl-face .maid-image').evaluate((image: HTMLImageElement) => image.currentSrc)).toMatch(/-motion\.webp$/)
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
    const face = island.el.querySelector('.isl-face')!
    let replacements = 0
    const observer = new MutationObserver(records => { replacements += records.length })
    observer.observe(face, { childList: true })
    island.setPointer(true)
    await new Promise(resolve => setTimeout(resolve, 450))
    const hovered = face.firstChild
    island.update({ form: 'mini', mood: 'idle', tone: 'quiet', label: '', recent: [] }, { now: Date.now() + 1000 })
    observer.disconnect()
    return { loaded: [...gallery.querySelectorAll('img')].every(image => image.naturalWidth > 0), count: gallery.querySelectorAll('img').length,
      replacements, retained: face.firstChild === hovered, folded: island.el.dataset.open, hovered: Boolean(island.el.querySelector('.isl-grip')) }
  })
  expect(stateGallery).toEqual({ loaded: true, count: 21, replacements: 1, retained: true, folded: 'false', hovered: true })
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
