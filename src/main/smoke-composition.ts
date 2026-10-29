import { run, report, type SmokeWindow } from './smoke-kit.ts'

/** Exercise the real renderer handlers: confirming IME text must never submit or dismiss an editor. */
export async function checkComposition(win: SmokeWindow): Promise<string[]> {
  const seen = await run(win, `(async () => {
    const { initialState, reduce } = await import('./state.js')
    const { renderTasksPage } = await import('./view/tasks-page.js')
    const { rewindEditor } = await import('./view/rewind.js')
    const { createIslandInput } = await import('./view/island-input.js')
    const results = []
    let serial = 0
    const cases = [
      { name: 'composing flag', isComposing: true },
      { name: 'IME confirmation 229', keyCode: 229 },
      { name: 'Shift Enter', shiftKey: true },
      { name: 'ordinary Enter' },
    ]
    for (const surface of ['task', 'edit', 'island']) for (const sample of cases) {
      let sent = 0
      const host = document.createElement('section')
      document.body.append(host)
      try {
        let field
        if (surface === 'task') {
          let state = reduce(initialState, { type: 'task_started', task: { id: 'ime-task-' + ++serial, title: '输入法验收', segmentId: 'ime' }, text: '合成请求', at: Date.now() })
          state = reduce(state, { type: 'tasks_page_open', taskId: state.tasks.list[0].id })
          renderTasksPage(host, state, { sendToTask: () => sent++ })
          field = host.querySelector('.tp-input')
        } else if (surface === 'edit') {
          host.append(rewindEditor({ id: 'ime-edit-' + ++serial, role: 'user', text: '原文' }, { submitEdit: () => sent++, cancelEdit: () => {} }, 0))
          field = host.querySelector('textarea')
        } else {
          const input = createIslandInput({ send: () => sent++, dismiss: () => {}, removeFile: () => {} })
          host.append(input.entry)
          field = input.field
        }
        field.value = '中文候选 尚未确认 🐈'
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...sample }))
        const expected = sample.name === 'ordinary Enter' ? 1 : 0
        results.push({ surface, sample: sample.name, ok: sent === expected, sent, expected })
      } finally { host.remove() }
    }
    const field = document.getElementById('composer-input')
    const prior = field.value
    try {
      for (const sample of cases.slice(0, 3)) {
        field.value = '未确认的中文 🐈'
        field.dispatchEvent(new Event('input', { bubbles: true }))
        const before = document.querySelectorAll('#thread .msg-user').length
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...sample }))
        results.push({ surface: 'main', sample: sample.name, ok: before === document.querySelectorAll('#thread .msg-user').length && field.value === '未确认的中文 🐈' })
      }
    } finally {
      field.value = prior
      field.dispatchEvent(new Event('input', { bubbles: true }))
    }
    document.getElementById('open-profile').click()
    await new Promise(resolve => requestAnimationFrame(resolve))
    for (const sample of [{ name: 'composing Escape', isComposing: true }, { name: '229 Escape', keyCode: 229 }]) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, ...sample }))
      results.push({ surface: 'main hub', sample: sample.name, ok: document.getElementById('hub').dataset.open === 'true' })
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return results
  })()`) as Array<{ surface: string, sample: string, ok: boolean }>
  report(`composition: ${JSON.stringify(seen)}`)
  return seen.filter(item => !item.ok).map(item => `composition ${item.surface} ${item.sample} changed or submitted unconfirmed input`)
}
