import { expect, type TestInfo } from '@playwright/test'
import type { SmokeApplication } from './application.ts'

/** Drive the production event ingress while Chromium delivers continuous wheel and held clicks. */
export async function checkStreamingDrawer(session: SmokeApplication, info: TestInfo): Promise<void> {
  const { page, application } = session
  const current = await page.evaluate(() => window.agent.getInfo())
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
          await stream.evaluate(stream => stream.step())
          await expect.poll(() => page.evaluate(() => {
            const body = document.querySelector('#drawer .drawer-body')!
            return body.scrollHeight - body.clientHeight - body.scrollTop
          })).toBeLessThanOrEqual(2)
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
}
