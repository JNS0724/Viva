import { expect, type Page } from '@playwright/test'

/** Exercise retained production nodes, including callbacks created before a disclosure or locale change. */
export async function checkUiPolish(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const { initialState, reduce } = await import(new URL('./state.js', location.href).href) as typeof import('../../src/renderer/state.ts')
    const { renderTasksPage } = await import(new URL('./view/tasks-page.js', location.href).href) as typeof import('../../src/renderer/view/tasks-page.ts')
    const { renderThread } = await import(new URL('./view/thread.js', location.href).href) as typeof import('../../src/renderer/view/thread.ts')
    const { restoreEditorFocus } = await import(new URL('./view/rewind.js', location.href).href) as typeof import('../../src/renderer/view/rewind.ts')
    const { getLocale, setLocale } = await import(new URL('../shared/i18n/locale.js', location.href).href) as typeof import('../../src/shared/i18n/locale.ts')
    const active = document.activeElement, locale = getLocale()
    const stage = document.createElement('section')
    stage.style.cssText = 'position:fixed;inset:60px 20px 20px;z-index:9999;background:var(--bg);overflow:auto'
    const tasks = document.createElement('section'), thread = document.createElement('div')
    stage.append(tasks, thread)
    document.body.append(stage)
    const task: BackgroundTask = { id: 'ui-polish-task', title: 'UI polish', status: 'done', startedAt: 1, endedAt: 2,
      view: { ...initialState, phase: 'idle', messages: [{ id: 'result', role: 'assistant', text: 'Result',
        receipt: { ms: 1000, tools: 1, thoughts: 0, stopReason: 'end_turn' } }],
      tools: { read: { title: 'Read', status: 'completed' } }, timeline: [{ kind: 'tool', ref: 'read', at: 1 }] } }
    let state: State = { ...initialState, tasks: { ...initialState.tasks, list: [task],
      page: { ...initialState.tasks.page, open: true, selected: task.id } } }
    const change = (action: Action) => {
      state = reduce(state, action)
      renderTasksPage(tasks, state, handlers, 3)
    }
    const handlers: Handlers = {
      openTaskSteps: () => change({ type: 'tasks_page_steps', open: true }),
      toggleTaskSteps: () => change({ type: 'tasks_page_steps' }),
      showAllTaskSteps: () => change({ type: 'tasks_page_all_steps' }),
    }
    try {
      renderTasksPage(tasks, state, handlers, 3)
      const receipt = tasks.querySelector<HTMLButtonElement>('.receipt')!
      const disclosures: boolean[] = []
      receipt.click()
      disclosures.push(state.tasks.page.steps)
      receipt.click()
      disclosures.push(state.tasks.page.steps)
      change({ type: 'tasks_page_all_steps' })
      receipt.click()
      const keptEarlierSteps = state.tasks.page.allSteps
      tasks.querySelector<HTMLButtonElement>('.tp-toggle')!.click()
      disclosures.push(state.tasks.page.steps)
      receipt.click()
      disclosures.push(state.tasks.page.steps)
      const retainedReceipt = tasks.querySelector('.receipt') === receipt

      const editing: State = { ...initialState, messages: [{ id: 'ui-polish-user', role: 'user', text: 'Original' }],
        rewind: { ...initialState.rewind, editing: 'ui-polish-user' } }
      renderThread(thread, editing, handlers, 4)
      const field = thread.querySelector<HTMLTextAreaElement>('.rewind-field')!
      field.value = 'Edited draft'
      field.setSelectionRange(3, 5)
      const changes = []
      for (const next of ['en', 'zh-CN'] as const) {
        setLocale(next)
        renderThread(thread, editing, handlers, 5)
        const shown = thread.querySelector<HTMLTextAreaElement>('.rewind-field')!
        changes.push({ locale: next, same: shown === field, focused: document.activeElement === shown,
          value: shown.value, start: shown.selectionStart, end: shown.selectionEnd,
          label: shown.getAttribute('aria-label'), button: thread.querySelector('.rewind-send')!.textContent })
      }
      return { disclosures, retainedReceipt, keptEarlierSteps, changes }
    } finally {
      restoreEditorFocus(null, null)
      setLocale(locale)
      stage.remove()
      if (active instanceof HTMLElement && active.isConnected) active.focus({ preventScroll: true })
    }
  })
  expect(result.disclosures).toEqual([true, true, false, true])
  expect(result.retainedReceipt).toBe(true)
  expect(result.keptEarlierSteps).toBe(true)
  expect(result.changes).toEqual([
    { locale: 'en', same: true, focused: true, value: 'Edited draft', start: 3, end: 5, label: 'Edit and resend', button: 'Resend' },
    { locale: 'zh-CN', same: true, focused: true, value: 'Edited draft', start: 3, end: 5, label: '改了重发', button: '重新发送' },
  ])
  await checkTitlebarWidth(page)
  await checkQuestionKeyboard(page)
}

/** The content's natural width must be measured independently of the capsule's previous width. */
async function checkTitlebarWidth(page: Page): Promise<void> {
  const rows = await page.evaluate(async () => {
    const { createIsland } = await import(new URL('./view/island-dom.js', location.href).href) as typeof import('../../src/renderer/view/island-dom.ts')
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:20px;top:60px;width:380px;max-width:380px;z-index:9999'
    const island = createIsland('bar', () => {})
    island.el.style.transition = 'none'
    host.append(island.el)
    document.body.append(host)
    const base = { mood: 'idle', recent: [] }
    const views: IslandShown[] = [
      { ...base, form: 'idle', tone: 'idle', label: '待命', detail: 'deepseek-chat' },
      { ...base, form: 'working', tone: 'working', label: '正在处理', startedAt: Date.now() - 60000, steps: 3 },
      { ...base, form: 'done', tone: 'done', label: '已完成', elapsedMs: 60000 },
      { ...base, form: 'idle', tone: 'idle', label: 'Ready', detail: 'deepseek-chat' },
      { ...base, form: 'done', tone: 'done', label: 'Completed', elapsedMs: 60000 },
    ]
    try {
      const rows = []
      for (const view of views) {
        island.update(view)
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        const label = island.el.querySelector<HTMLElement>('.isl-label')!
        rows.push({ label: view.label, content: label.scrollWidth, visible: label.clientWidth })
      }
      return rows
    } finally { host.remove() }
  })
  for (const row of rows) expect(row.visible, `${row.label} stays readable as the capsule resizes`).toBeGreaterThanOrEqual(row.content - 1)
}

/** Answer choices are ordinary buttons: tab through them, then explicitly submit one with Enter or Space. */
async function checkQuestionKeyboard(page: Page): Promise<void> {
  const probe = await page.evaluateHandle(async () => {
    const { initialState } = await import(new URL('./state.js', location.href).href) as typeof import('../../src/renderer/state.ts')
    const { renderThread } = await import(new URL('./view/thread.js', location.href).href) as typeof import('../../src/renderer/view/thread.ts')
    const active = document.activeElement, stage = document.createElement('section')
    stage.id = 'ui-polish-question'
    stage.style.cssText = 'position:fixed;inset:60px 20px 20px;z-index:9999;background:var(--bg);overflow:auto'
    document.body.append(stage)
    const picked: string[] = []
    renderThread(stage, { ...initialState, phase: 'asking', question: { questionId: 'ui-polish-choice', picks: {},
      questions: [{ id: 'city', question: 'Choose a city', options: [{ label: 'Shanghai' }, { label: 'Beijing' }] }] } },
    { pickOption: (_id: string, label: string) => picked.push(label) }, Date.now())
    return { picked: () => [...picked], dispose() {
      stage.remove()
      if (active instanceof HTMLElement && active.isConnected) active.focus({ preventScroll: true })
    } }
  })
  try {
    const group = page.locator('#ui-polish-question').getByRole('group', { name: 'Choose a city' })
    const first = group.getByRole('button', { name: 'Shanghai', exact: true })
    const second = group.getByRole('button', { name: 'Beijing', exact: true })
    await first.focus()
    await page.keyboard.press('Tab')
    await expect(second).toBeFocused()
    await page.keyboard.press('Enter')
    await first.focus()
    await page.keyboard.press('Space')
    expect(await probe.evaluate(probe => probe.picked())).toEqual(['Beijing', 'Shanghai'])
  } finally {
    await probe.evaluate(probe => probe.dispose())
    await probe.dispose()
  }
}
