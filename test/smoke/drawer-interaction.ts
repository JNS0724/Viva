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
  const stream = await main.evaluateHandle(() => {
    // Use the production publication boundary, including its trusted generation/cursor.
    const pending = new Set<Promise<void>>()
    const send = (event: object) => {
      const sent = globalThis.vivaAutomation!.publishEvent(event)
      pending.add(sent)
      void sent.finally(() => pending.delete(sent)).catch(() => {})
    }
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
      stop: async () => { clearInterval(timer); send({ type: 'turn_end', stopReason: 'end_turn' }); await Promise.all(pending) },
    }
  })
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
  await checkTraceDetail(page, info)
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


/** Read-only model and tool details in the production renderer, with no approval or debugging workbench. */
async function checkTraceDetail(page: Page, info: TestInfo): Promise<void> {
  await page.evaluate(async () => {
    const { renderDrawer } = await import(new URL('./view/drawer.js', location.href).href) as typeof import('../../src/renderer/view/drawer.ts')
    const { initialState, reduce } = await import(new URL('./state.js', location.href).href) as typeof import('../../src/renderer/state.ts')
    const { modelCallId } = await import(new URL('../shared/trace.js', location.href).href) as typeof import('../../src/shared/trace.ts')
    const container = document.createElement('aside')
    container.id = 'trace-detail-review'
    container.className = 'drawer'
    Object.assign(container.style, { position: 'fixed', right: '0', top: '0', bottom: '0', zIndex: '1000' })
    document.body.append(container)
    const call = { sessionId: '11111111-2222-3333-4444-555555555555', turn: 1, step: 1, at: 1000, status: 'completed' as const,
      provider: 'deepseek', model: 'deepseek-v4', attempts: 2, inputTokens: 1200, outputTokens: 80, durationMs: 3400 }
    const id = modelCallId(call)
    const longText = '完整提示词。'.repeat(2000)
    const request = { provider: 'deepseek', model: 'deepseek-v4', config: {}, messages: [
      { role: 'system', content: [{ type: 'text', text: '你是 Viva' }] },
      { role: 'developer', content: [{ type: 'tool-addition', toolName: 'read' }] },
      { role: 'user', content: [{ type: 'text', text: longText }] },
    ], tools: [{ name: 'read' }] }
    let state: State = { ...initialState, drawer: 'trace', conversationId: 'detail-review', modelCalls: { [id]: call },
      tools: { read: { title: '读取需求', kind: 'read', status: 'completed', rawInput: { file_path: '/w/a.md' }, rawOutput: longText } },
      timeline: [{ kind: 'model', ref: id, at: 1000 }, { kind: 'tool', ref: 'read', at: 1001 }] }
    const handlers = new Proxy({
      openTraceDetail(item: ReturnType<typeof import('../../src/renderer/selectors.ts').traceItems>[number]) {
        state = reduce(state, { type: 'trace_detail_open', key: item.key, conversationId: 'detail-review', loading: false })
        if (item.entry.kind === 'model') state = reduce(state, { type: 'trace_detail_loaded', key: item.key, conversationId: 'detail-review', request: { call, request } })
        renderDrawer(container, state, handlers)
      },
      closeTraceDetail() { state = reduce(state, { type: 'trace_detail_close' }); renderDrawer(container, state, handlers) },
      copyTraceText(text: string) { container.dataset.copied = text },
      closeDrawer() {},
    }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as Handlers
    renderDrawer(container, state, handlers)
    container.querySelector<HTMLButtonElement>('[data-trace-key^="model-"]')!.click()
    await new Promise(resolve => setTimeout(resolve, 120))
  })
  await page.locator('#trace-detail-review .trace-detail-view').waitFor()
  const model = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('#trace-detail-review')!
    return { roles: [...root.querySelectorAll('.trace-role')].map(node => node.textContent),
      longLength: root.querySelector('.trace-structured')!.textContent!.length,
      readOnly: !root.querySelector('.trace-go-request, .trace-search, .trace-outline, .drawer-resize') }
  })
  expect(model.roles).toEqual(['系统', '环境更新', '用户'])
  expect(model.longLength).toBeGreaterThan(10000)
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('trace-back')), {
    message: 'the detail back button receives focus after the queued layout write',
  }).toBe(true)
  expect(model.readOnly).toBe(true)
  await info.attach('trace-model-detail.png', { body: await page.screenshot(), contentType: 'image/png' })
  const result = await page.evaluate(async () => {
    const root = document.querySelector<HTMLElement>('#trace-detail-review')!
    root.querySelector<HTMLButtonElement>('[data-detail-tab="json"]')!.click()
    const raw = root.querySelector('.trace-raw')!.textContent!
    root.querySelector<HTMLButtonElement>('.trace-copy')!.click()
    root.querySelector<HTMLButtonElement>('.trace-back')!.click()
    await new Promise(resolve => setTimeout(resolve, 120))
    return { valid: JSON.parse(raw).messages[1].role === 'developer', copied: root.dataset.copied === raw,
      returned: root.querySelectorAll('.trace-row').length === 2 }
  })
  expect(result).toEqual({ valid: true, copied: true, returned: true })
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-trace-key')?.startsWith('model-') ?? false)).toBe(true)
  await page.evaluate(() => document.querySelector('#trace-detail-review')?.remove())
}
