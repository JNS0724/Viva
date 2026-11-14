import { expect, type Page, type TestInfo } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import type { SmokeApplication } from './application.ts'

/** Drive the production event ingress while Chromium delivers continuous wheel and held clicks. */
export async function checkStreamingDrawer(session: SmokeApplication, info: TestInfo): Promise<void> {
  const { page, application } = session
  const current = await page.evaluate(() => window.agent.getInfo())
  fs.writeFileSync(path.join(current.cwd, 'drawer-long-preview.txt'), Array.from({ length: 40000 }, (_, index) => `${index}: ${'test text '.repeat(8)}\n`).join(''))
  const main = await application.browserWindow(page)
  const stream = await main.evaluateHandle((window, context) => {
    const send = (event: object) => window.webContents.send('agent:event', { ...event, context })
    send({ type: 'turn_started' })
    let steps = 0
    const step = () => {
      const index = steps++
      send({ type: 'update', update: {
        sessionUpdate: 'tool_call', toolCallId: `drawer-step-${index}`, title: `读取过程记录 ${index}`,
        kind: 'read', status: 'completed', rawInput: { path: `notes/step-${index}.md` },
      } })
    }
    for (let index = 0; index < 70; index++) step()
    let mode = 'agent_thought_chunk', chunks = 0
    const timer = setInterval(() => {
      chunks++
      send({ type: 'update', update: { sessionUpdate: mode, content: { type: 'text', text: `持续更新 ${chunks}。` } } })
    }, 16)
    return {
      count: () => chunks,
      answer: () => { mode = 'agent_message_chunk' },
      think: () => { mode = 'agent_thought_chunk' },
      step,
      stop: () => { clearInterval(timer); send({ type: 'turn_end', stopReason: 'end_turn' }) },
    }
  }, { conversationId: current.conversationId ?? null, sessionId: current.sessionId ?? null })
  const results = []
  let following = { readerKept: false, resumed: false }, filesRetained = false
  try {
    for (const phase of ['thinking', 'answering']) {
      if (phase === 'answering') await stream.evaluate(stream => stream.answer())
      for (let attempt = 0; attempt < 2; attempt++) {
        if (await page.locator('#drawer').getAttribute('data-open') === 'true') await page.locator('#toggle-drawer').click()
        await page.locator('#toggle-drawer').click()
        await expect.poll(() => page.locator('#drawer .trace-row').count()).toBeGreaterThan(70)
        const retained = await page.evaluateHandle(() => ({
          close: document.querySelector('#drawer .drawer-head > .icon-btn')!,
          body: document.querySelector('#drawer .drawer-body')!,
          row: document.querySelector('#drawer .trace-row')!,
        }))
        await expect.poll(() => page.evaluate(() => document.querySelector('#drawer .drawer-body')!.scrollTop)).toBeGreaterThan(100)
        const before = await page.evaluate(() => document.querySelector('#drawer .drawer-body')!.scrollTop)
        const bounds = await page.evaluate(() => document.querySelector('#drawer .drawer-body')!.getBoundingClientRect().toJSON())
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        for (let wheel = 0; wheel < 5; wheel++) {
          await page.mouse.wheel(0, -160)
          await page.waitForTimeout(40)
        }
        const afterWheel = await page.evaluate(() => document.querySelector('#drawer .drawer-body')!.scrollTop)
        const chunksBefore = await stream.evaluate(stream => stream.count())
        await expect.poll(() => stream.evaluate(stream => stream.count())).toBeGreaterThan(chunksBefore + 5)
        const afterUpdates = await page.evaluate(() => document.querySelector('#drawer .drawer-body')!.scrollTop)
        const identity = await retained.evaluate(retained => ({
          close: retained.close === document.querySelector('#drawer .drawer-head > .icon-btn') && retained.close.isConnected,
          body: retained.body === document.querySelector('#drawer .drawer-body') && retained.body.isConnected,
          row: retained.row === document.querySelector('#drawer .trace-row') && retained.row.isConnected,
        }))
        if (phase === 'thinking' && attempt === 0) {
          await stream.evaluate(stream => stream.step())
          await page.waitForTimeout(100)
          following.readerKept = Math.abs(await page.evaluate(() => document.querySelector('#drawer .drawer-body')!.scrollTop) - afterUpdates) <= 2
          await page.evaluate(() => { const body = document.querySelector('#drawer .drawer-body')!; body.scrollTop = body.scrollHeight })
          await page.waitForTimeout(80)
          for (let step = 0; step < 5; step++) {
            await stream.evaluate(stream => stream.step())
            await page.waitForTimeout(80)
            await expect.poll(() => page.evaluate(() => {
              const body = document.querySelector('#drawer .drawer-body')!
              return body.scrollHeight - body.clientHeight - body.scrollTop
            })).toBeLessThanOrEqual(2)
          }
          following.resumed = true
        }
        const closeBounds = await page.evaluate(() => document.querySelector('#drawer .drawer-head > .icon-btn')!.getBoundingClientRect().toJSON())
        await page.mouse.move(closeBounds.x + closeBounds.width / 2, closeBounds.y + closeBounds.height / 2)
        await page.mouse.down()
        const pressedAt = await stream.evaluate(stream => stream.count())
        await expect.poll(() => stream.evaluate(stream => stream.count())).toBeGreaterThan(pressedAt + 4)
        await page.mouse.up()
        await page.waitForTimeout(80)
        const closed = await page.locator('#drawer').getAttribute('data-open') === 'false'
        results.push({ phase, attempt, before, afterWheel, afterUpdates, identity, closed })
        await retained.dispose()
      }
    }
    await stream.evaluate(stream => stream.think())
    if (await page.locator('#drawer').getAttribute('data-open') !== 'true') await page.locator('#toggle-drawer').click()
    await page.getByRole('tab', { name: '文件', exact: true }).click()
    const files = await page.evaluateHandle(() => document.querySelector('#drawer .files')!)
    const started = await stream.evaluate(stream => stream.count())
    await expect.poll(() => stream.evaluate(stream => stream.count())).toBeGreaterThan(started + 8)
    filesRetained = await files.evaluate(files => files.isConnected && files === document.querySelector('#drawer .files'))
    await files.dispose()
    await page.locator('#drawer .file-row').filter({ hasText: 'drawer-long-preview.txt' }).click()
    await expect.poll(() => page.evaluate(() => document.querySelector('.file-preview[data-path]')?.textContent?.length ?? 0)).toBeGreaterThan(100000)
    // Content arrives before the queued layout restores its scroll. Scroll only after the preview is painted.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const firstPage = await page.evaluate(() => {
      const preview = document.querySelector('.file-preview[data-path]')!
      const top = preview.scrollHeight - preview.clientHeight
      return { length: preview.textContent!.length, top }
    })
    await page.evaluate(() => { const preview = document.querySelector('.file-preview[data-path]')!; preview.scrollTop = preview.scrollHeight })
    await expect.poll(() => page.evaluate(() => document.querySelector('.file-preview[data-path]')!.textContent!.length)).toBeGreaterThan(firstPage.length + 1000)
    await page.waitForTimeout(120)
    const pagedTop = await page.evaluate(() => document.querySelector('.file-preview[data-path]')!.scrollTop)
    const pagedLength = await page.evaluate(() => document.querySelector('.file-preview[data-path]')!.textContent!.length)
    expect(pagedTop, 'automatic preview paging preserves the reading position').toBeGreaterThanOrEqual(firstPage.top - 2)
    expect(pagedLength, 'detached preview events never request extra pages').toBeLessThan(firstPage.length * 2 + 5000)
    await info.attach('drawer-preview-paging', { body: JSON.stringify({ firstPage, pagedTop, pagedLength }), contentType: 'application/json' })
    await page.locator('#drawer .drawer-head > .icon-btn').click({ delay: 120 })
    await expect(page.locator('#drawer')).toHaveAttribute('data-open', 'false')
  } finally {
    await stream.evaluate(stream => stream.stop())
    await stream.dispose()
    await info.attach('streaming-drawer-interaction', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
    await info.attach('streaming-drawer-following', { body: JSON.stringify({ following, filesRetained }), contentType: 'application/json' })
  }
  for (const result of results) {
    expect(result.identity, `${result.phase} keeps interactive nodes attached`).toEqual({ close: true, body: true, row: true })
    expect(result.afterWheel, `${result.phase} responds to continuous wheel input`).toBeLessThan(result.before - 640)
    expect(Math.abs(result.afterUpdates - result.afterWheel), `${result.phase} preserves the reader position`).toBeLessThanOrEqual(2)
    expect(result.closed, `${result.phase} closes after updates between mouse down and up`).toBe(true)
  }
  expect(following).toEqual({ readerKept: true, resumed: true })
  expect(filesRetained, 'thinking updates preserve the file browser').toBe(true)
  await checkDrawerBoundaries(page, info)
}

/** Exercise subpixel scroll writes and synchronous topic transitions in the real renderer. */
async function checkDrawerBoundaries(page: Page, info: TestInfo): Promise<void> {
  const boundaries = await page.evaluate(async () => {
    const { renderDrawer } = await import(new URL('./view/drawer.js', location.href).href) as typeof import('../../src/renderer/view/drawer.ts')
    const { initialState, reduce } = await import(new URL('./state.js', location.href).href) as typeof import('../../src/renderer/state.ts')
    const container = document.createElement('aside')
    container.className = 'drawer'
    Object.assign(container.style, { position: 'fixed', right: '0px', top: '40px', height: '401px', zIndex: '1000' })
    document.body.append(container)
    const handlers = new Proxy({}, { get: () => () => {} }) as Handlers
    const settle = () => new Promise(resolve => setTimeout(resolve, 100))
    const addRows = (state: State, count: number, prefix: string): State => {
      for (let index = 0; index < count; index++) state = reduce(state, {
        type: 'acp_update', at: 1000 + index,
        update: { sessionUpdate: 'tool_call', toolCallId: `${prefix}-${index}`, title: `步骤 ${index}`, kind: 'read', status: 'completed' },
      })
      return state
    }
    const distance = () => {
      const body = container.querySelector('.drawer-body')!
      return body.scrollHeight - body.clientHeight - body.scrollTop
    }
    const samples = []
    try {
      for (const count of [20, 31, 39]) {
        let state = addRows({ ...initialState, drawer: 'trace' }, count, 'initial')
        renderDrawer(container, state, handlers)
        await settle()
        for (let append = 0; append < 3; append++) {
          state = addRows(state, 1, `appended-${append}`)
          renderDrawer(container, state, handlers)
          await settle()
          samples.push({ name: `fractional-${count}-${append}`, distance: distance() })
        }
        renderDrawer(container, { ...state, drawer: null }, handlers)
      }
      for (const reset of ['new_session', 'topic_resumed'] as const) {
        let state = addRows({ ...initialState, drawer: 'trace' }, 70, 'old')
        renderDrawer(container, state, handlers)
        await settle()
        container.querySelector('.drawer-body')!.scrollTop = 200
        await settle()
        state = reduce(state, reset === 'new_session' ? { type: reset, at: 2000 }
          : { type: reset, info: { ...state.info, conversationId: 'resumed' }, parentId: 'old', at: 2000 })
        renderDrawer(container, state, handlers)
        state = addRows(state, 70, 'new')
        renderDrawer(container, state, handlers)
        await settle()
        samples.push({ name: reset, distance: distance() })
        renderDrawer(container, { ...state, drawer: null }, handlers)
      }
      return samples
    } finally { container.remove() }
  })
  await info.attach('drawer-scroll-boundaries', { body: JSON.stringify(boundaries), contentType: 'application/json' })
  for (const sample of boundaries) expect(Math.abs(sample.distance), sample.name).toBeLessThanOrEqual(2)
}
