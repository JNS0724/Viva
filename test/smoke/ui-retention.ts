import { expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { SmokeApplication } from './application.ts'

/** Deliver a real Chromium press across updates, instead of dispatching element.click(). */
async function heldClick(page: Page, target: Locator, update: () => Promise<unknown>): Promise<boolean> {
  await target.click({ trial: true })
  const original = await target.elementHandle()
  if (!original) throw new Error('Missing interaction target')
  const box = await target.boundingBox()
  if (!box) throw new Error('Interaction target has no bounds')
  try {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    let connected = false
    try {
      await update()
      connected = await original.evaluate(node => node.isConnected)
    } finally { await page.mouse.up() }
    return connected
  } finally { await original.dispose() }
}

/** The app's production ingress must keep unrelated navigation usable during background streaming. */
export async function checkStreamingNavigation(session: SmokeApplication, info: TestInfo): Promise<void> {
  const { page, application } = session
  const current = await page.evaluate(() => window.agent.getInfo())
  const main = await application.browserWindow(page)
  const stream = await main.evaluateHandle((window, context) => {
    const ids = ['ui-retention-running', 'ui-retention-other']
    const send = (event: object) => window.webContents.send('agent:event', { ...event, context })
    const startedAt = Date.now()
    for (const taskId of ids) send({ type: 'task_snapshot', snapshot: {
      taskId, runId: 'ui-retention-run', title: taskId, status: 'running', currentAction: null, waitingFor: null,
      startedAt, updatedAt: startedAt, endedAt: null, resultPreview: '', revision: 1, taskSeq: 0,
      opening: { words: taskId, task: { id: taskId, segmentId: taskId, title: taskId, words: taskId }, hostSession: context.sessionId },
    } })
    let chunks = 0
    const piece = (text: string) => send({ type: 'task_update', taskId: ids[0], runId: 'ui-retention-run', taskSeq: ++chunks,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
    piece(Array.from({ length: 150 }, (_, i) => `第 ${i} 段后台阅读内容。\n\n`).join(''))
    const timer = setInterval(() => piece('持续输出。'), 16)
    return { count: () => chunks, stop: () => clearInterval(timer) }
  }, { conversationId: current.conversationId ?? null, sessionId: current.sessionId ?? null })
  const retained: Record<string, boolean> = {}
  const acrossUpdates = async () => {
    const before = await stream.evaluate(stream => stream.count())
    await expect.poll(() => stream.evaluate(stream => stream.count())).toBeGreaterThan(before + 5)
  }
  try {
    await page.locator('#model-btn').click()
    const model = page.locator('#model-menu .model-option').first()
    const clicked = await model.evaluateHandle(node => {
      const seen = { clicks: 0 }
      node.addEventListener('click', () => { seen.clicks++ })
      return seen
    })
    try {
      retained.model = await heldClick(page, model, acrossUpdates)
      expect(await clicked.evaluate(seen => seen.clicks), 'one native model selection click arrives').toBe(1)
    } finally { await clicked.dispose() }
    await page.locator('#model-btn').click()
    await page.locator('#composer-context').click()
    retained.workdir = await heldClick(page, page.locator('#workdir-menu .workdir-item[aria-current="true"]'), acrossUpdates)
    await expect(page.locator('#workdir-menu .workdir-menu')).toHaveCount(0)

    await page.locator('#open-profile').click()
    await page.locator('.hub-nav[data-page="tasks"]').click()
    retained.task = await heldClick(page, page.locator('#tasks-page .tp-row').filter({ hasText: 'ui-retention-other' }), acrossUpdates)
    await expect(page.locator('#tasks-page .tp-main')).toHaveAttribute('data-task', 'ui-retention-other')
    retained.fold = await heldClick(page, page.locator('#tasks-page .tp-fold'), acrossUpdates)
    await expect(page.locator('#tasks-page .tp-side')).toHaveClass(/tp-side-folded/)
    retained.unfold = await heldClick(page, page.locator('#tasks-page .tp-fold'), acrossUpdates)
    await expect(page.locator('#tasks-page .tp-row')).toHaveCount(2)

    await page.locator('#tasks-page .tp-row').filter({ hasText: 'ui-retention-running' }).click()
    const scroll = page.locator('#tasks-page .tp-scroll')
    await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBeGreaterThan(500)
    const before = await scroll.evaluate(node => node.scrollTop)
    await scroll.hover()
    for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -160); await page.waitForTimeout(40) }
    const reading = await scroll.evaluate(node => node.scrollTop)
    await acrossUpdates()
    const after = await scroll.evaluate(node => node.scrollTop)
    expect(reading).toBeLessThan(before - 640)
    expect(Math.abs(after - reading), 'streaming preserves the task reading position').toBeLessThanOrEqual(2)
    expect(retained).toEqual({ model: true, workdir: true, task: true, fold: true, unfold: true })
    await info.attach('streaming-navigation', { body: JSON.stringify({ retained, before, reading, after }), contentType: 'application/json' })
    await page.locator('#hub-back').click()
  } finally {
    await stream.evaluate(stream => stream.stop())
    await stream.dispose()
  }
  await checkRequestRegions(page, info)
  await checkTaskPageTransitions(page, info)
}

/** Request identity, isolated from summaries: updates retain a request, replacements receive new handlers. */
async function checkRequestRegions(page: Page, info: TestInfo): Promise<void> {
  const probe = await page.evaluateHandle(async () => {
    const { createIsland } = await import(new URL('./view/island-dom.js', location.href).href) as typeof import('../../src/renderer/view/island-dom.ts')
    const { renderWorkDir } = await import(new URL('./view/workdir.js', location.href).href) as typeof import('../../src/renderer/view/workdir.ts')
    const { initialState } = await import(new URL('./state.js', location.href).href) as typeof import('../../src/renderer/state.ts')
    const active = document.activeElement
    const stage = document.createElement('section')
    stage.id = 'retention-fixture'
    stage.style.cssText = 'position:fixed;inset:0;z-index:9999;padding:40px;background:var(--bg);overflow:auto'
    document.body.append(stage)
    const calls: Array<{ kind: string, requestId?: unknown, questionId?: unknown }> = []
    let view: IslandShown, island: ReturnType<typeof createIsland> | null = null
    let render = () => {}
    let original: Element | null = null
    let expected = '', serial = 0
    return {
      mount(kind: string) {
        stage.replaceChildren()
        calls.length = 0
        if (kind === 'workdir-confirm') {
          const dom = { context: document.createElement('button'), workdirMenu: document.createElement('div'), workdirConfirm: document.createElement('div') }
          stage.append(dom.context, dom.workdirMenu, dom.workdirConfirm)
          const state = { ...initialState, workDir: { ...initialState.workDir, confirm: '/retention/new-folder' } }
          const handlers = { cancelWorkDir: () => calls.push({ kind: 'cancel' }) } as Handlers
          render = () => renderWorkDir(dom, state, handlers, 'win32')
          expected = '.workdir-sheet .btn-secondary'
        } else {
          const host = kind === 'bar' ? 'bar' : 'desk'
          island = createIsland(host, action => calls.push(action))
          stage.append(island.el)
          view = {
            form: kind === 'permission' ? 'waiting' : kind === 'question' ? 'asking' : 'working',
            tone: 'working', mood: 'thinking', label: '保持有效的请求', desktopOpen: true,
            recent: [{ title: '读取文件', tone: 'live' }],
            permission: { requestId: 'request-1', title: '执行校验', command: 'npm test', options: [{ optionId: 'allow', name: '允许', role: 'primary' }] },
            question: { questionId: 'question-1', id: 'part', text: '先检查哪一项？', options: ['外观', '交互'], skippable: true },
            background: { count: 2, done: 0, items: [
              { id: 'first', title: '第一个任务', status: 'running', now: '读取文件' },
              { id: 'second', title: '第二个任务', status: 'running', now: '检查代码' },
            ] },
          }
          render = () => island!.update(view, { pinned: true })
          expected = kind === 'permission' ? '.isl-footer .isl-btn-primary'
            : kind === 'question' ? '.isl-choices button:first-child' : '.isl-actions .isl-btn-line'
        }
        render()
        return '#retention-fixture ' + expected
      },
      retain() {
        original = stage.querySelector(expected)
        if (!(original instanceof HTMLElement)) throw new Error('Missing request target')
        original.focus()
      },
      async update(replace: boolean) {
        for (let i = 0; i < 6; i++) {
          if (view) view = { ...view, label: `状态标题 ${++serial}`, detail: `状态摘要 ${serial}`,
            recent: [{ title: `读取步骤 ${serial}`, tone: 'live' }],
            background: { ...view.background, items: view.background.items.map((item: { id: string }) => ({ ...item, now: `检查代码 ${serial}` })) } }
          if (view?.form === 'waiting') view = { ...view, question: { ...view.question, text: `其他问题 ${serial}` } }
          if (view?.form === 'asking') view = { ...view, permission: { ...view.permission, title: `其他授权 ${serial}` } }
          if (replace && i === 0 && view) view = { ...view,
            permission: { ...view.permission, requestId: 'request-2' }, question: { ...view.question, questionId: 'question-2' } }
          render()
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        }
      },
      result: () => ({ same: original === stage.querySelector(expected), connected: original?.isConnected, focused: document.activeElement === original, calls: [...calls] }),
      dispose() {
        stage.remove()
        if (active instanceof HTMLElement && active.isConnected) active.focus({ preventScroll: true })
      },
    }
  })
  const results = []
  try {
    for (const kind of ['workdir-confirm', 'permission', 'question', 'bar']) {
      const selector = await probe.evaluate((probe, kind) => probe.mount(kind), kind)
      const target = page.locator(selector)
      await target.click({ trial: true })
      await probe.evaluate(probe => probe.retain())
      await heldClick(page, target, () => probe.evaluate(probe => probe.update(false)))
      const result = await probe.evaluate(probe => probe.result())
      results.push({ kind, ...result })
      expect(result.same && result.connected && result.focused, kind).toBe(true)
      expect(result.calls, kind).toHaveLength(1)
      if (kind === 'permission' || kind === 'question') {
        const count = result.calls.length
        await heldClick(page, target, () => probe.evaluate(probe => probe.update(true)))
        const replaced = await probe.evaluate(probe => probe.result())
        expect(replaced.connected, 'the old request target is detached').toBe(false)
        expect(replaced.calls, 'releasing over a replacement never answers the new request').toHaveLength(count)
        await target.click()
        const latest = await probe.evaluate(probe => probe.result())
        const action = latest.calls.at(-1)!
        expect(kind === 'permission' ? action.requestId : action.questionId).toBe(kind === 'permission' ? 'request-2' : 'question-2')
      }
    }
  } finally {
    await info.attach('request-region-retention', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
    await probe.evaluate(probe => probe.dispose())
    await probe.dispose()
  }
}

async function checkTaskPageTransitions(page: Page, info: TestInfo): Promise<void> {
  const result = await page.evaluate(async () => {
    const { initialState } = await import(new URL('./state.js', location.href).href) as typeof import('../../src/renderer/state.ts')
    const { renderTasksPage } = await import(new URL('./view/tasks-page.js', location.href).href) as typeof import('../../src/renderer/view/tasks-page.ts')
    const active = document.activeElement, stage = document.createElement('section')
    stage.style.cssText = 'position:fixed;inset:20px;z-index:9999;display:flex;background:var(--bg);overflow:hidden'
    document.body.append(stage)
    const calls: string[] = []
    const handlers = { stopTask: (id: string) => calls.push(`stop:${id}`), closeTask: (id: string) => calls.push(`close:${id}`) } as Handlers
    const text = '后台任务的长内容。\n\n'.repeat(150)
    const tasks: BackgroundTask[] = Array.from({ length: 40 }, (_, i) => ({
      id: `transition-${i}`, title: `任务 ${i}`, status: 'running', startedAt: 1000, endedAt: null,
      view: { ...initialState, phase: 'working', messages: [{ id: `message-${i}`, role: 'assistant', text, shown: text.length, open: true }] },
    }))
    let state: State = { ...initialState, tasks: { ...initialState.tasks, list: tasks,
      page: { ...initialState.tasks.page, open: true, selected: tasks[0].id } } }
    const changeStatus = (status: string) => {
      state = { ...state, tasks: { ...state.tasks, list: state.tasks.list.map((task, i) => i === 0 ? { ...task, status } : task) } }
      renderTasksPage(stage, state, handlers, 10000)
    }
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    try {
      renderTasksPage(stage, state, handlers, 10000)
      const main = stage.querySelector('.tp-main'), thread = stage.querySelector('.tp-thread')
      const side = stage.querySelector<HTMLElement>('.tp-side')!
      changeStatus('waiting') // Another snapshot arrives before the first layout restoration.
      await frame()
      const initialTop = stage.querySelector('.tp-scroll')!.scrollTop
      side.scrollTop = 200
      await frame()
      const sideTop = side.scrollTop
      // Progress changes keep the order. A lifecycle change may legitimately move a row to another group.
      state = { ...state, tasks: { ...state.tasks, list: state.tasks.list.map((task, i) => i === 2 ? { ...task, now: '更新进度' } : task) } }
      renderTasksPage(stage, state, handlers, 10000)
      await frame()
      const afterSideTop = side.scrollTop
      stage.querySelector<HTMLButtonElement>('.tp-act')!.click()
      changeStatus('done')
      await frame()
      stage.querySelector<HTMLButtonElement>('.tp-act')!.click()
      return { initialTop, sameMain: main === stage.querySelector('.tp-main'), sameThread: thread === stage.querySelector('.tp-thread'),
        sameSide: side === stage.querySelector('.tp-side'), sideTop, afterSideTop, calls }
    } finally {
      stage.remove()
      if (active instanceof HTMLElement && active.isConnected) active.focus({ preventScroll: true })
    }
  })
  await info.attach('task-page-transitions', { body: JSON.stringify(result), contentType: 'application/json' })
  expect(result.initialTop, 'same-frame snapshots keep initial bottom restoration').toBeGreaterThan(500)
  expect(result.sameMain && result.sameThread && result.sameSide).toBe(true)
  expect(result.sideTop, 'fixture sidebar can scroll').toBeGreaterThan(100)
  expect(result.afterSideTop, 'progress changes preserve sidebar scrolling').toBe(result.sideTop)
  expect(result.calls).toEqual(['stop:transition-0', 'close:transition-0'])
}
