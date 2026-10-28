import { report, run, type SmokeWindow } from './smoke-kit.ts'

/** Real DOM entry points, including asynchronous redraws while a task request is refused. */
export async function checkInputBoundaries(win: SmokeWindow): Promise<string[]> {
  const results = await run(win, `(async () => {
    const { initialState, reduce } = await import('./state.js')
    const { renderTasksPage } = await import('./view/tasks-page.js')
    const { MAX_MESSAGE_CHARS, MESSAGE_TOO_LONG } = await import('../shared/text-limits.js')
    const results = []
    const over = '长'.repeat(MAX_MESSAGE_CHARS + 1)
    const field = document.getElementById('composer-input')
    const prior = field.value
    const count = () => document.querySelectorAll('#thread .msg-user,.task-card,.task-submission').length
    try {
      for (const action of ['Enter', 'background']) {
        field.value = over
        field.dispatchEvent(new Event('input', { bubbles: true }))
        const before = count()
        if (action === 'Enter') field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        else document.getElementById('bg-send').click()
        results.push({ check: 'main oversized ' + action, ok: count() === before && field.value === over && document.getElementById('toast-root').textContent.includes(MESSAGE_TOO_LONG) })
      }
    } finally { field.value = prior; field.dispatchEvent(new Event('input', { bubbles: true })) }

    for (const scenario of ['oversize', 'exact limit', 'refused through redraw', 'newer typing', 'other task', 'rejected request']) {
      let state = initialState
      for (const id of ['input-first', 'input-other']) state = reduce(state, { type: 'task_started', task: { id, title: id, segmentId: id }, text: '合成请求', at: Date.now() })
      state = reduce(state, { type: 'tasks_page_open', taskId: 'input-first' })
      const host = document.createElement('section')
      document.body.append(host)
      let calls = 0, resolve, reject
      const problems = []
      const handlers = {
        inputProblem: text => problems.push(text),
        sendToTask: () => { calls++; return new Promise((yes, no) => { resolve = yes; reject = no }) },
      }
      try {
        renderTasksPage(host, state, handlers)
        const input = host.querySelector('.tp-input')
        const draft = scenario === 'oversize' ? over : scenario === 'exact limit' ? '中'.repeat(MAX_MESSAGE_CHARS) : '  未送达的完整草稿 🐈  '
        input.value = draft
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        if (scenario === 'oversize') {
          results.push({ check: scenario, ok: calls === 0 && input.value === draft && problems[0] === MESSAGE_TOO_LONG })
          continue
        }
        if (scenario === 'other task') state = reduce(state, { type: 'tasks_page_select', taskId: 'input-other' })
        renderTasksPage(host, state, handlers)
        const current = host.querySelector('.tp-input')
        if (scenario === 'newer typing' || scenario === 'other task') current.value = '后来写的新草稿'
        if (scenario === 'rejected request') reject(new Error('synthetic transport failure'))
        else resolve(scenario === 'exact limit')
        await new Promise(done => setTimeout(done, 0))
        const expected = scenario === 'exact limit' ? '' : (scenario === 'newer typing' || scenario === 'other task') ? '后来写的新草稿' : draft
        results.push({ check: scenario, ok: calls === 1 && current.value === expected, length: current.value.length, problems })
      } finally { host.remove() }
    }
    return results
  })()`) as Array<{ check: string, ok: boolean }>
  report(`input boundaries: ${JSON.stringify(results)}`)
  return results.filter(result => !result.ok).map(result => `input boundary ${result.check} did not preserve or bound the draft`)
}
