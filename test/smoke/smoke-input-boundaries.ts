import { report, run, type SmokeWindow } from './smoke-kit.ts'

/** The composer refuses words past the limit, keeping them for the user to shorten. */
export async function checkInputBoundaries(win: SmokeWindow): Promise<string[]> {
  const results = await run(win, `(async () => {
    const { MAX_MESSAGE_CHARS, MESSAGE_TOO_LONG } = await import('../shared/text-limits.js')
    const results = []
    const over = '长'.repeat(MAX_MESSAGE_CHARS + 1)
    const field = document.getElementById('composer-input')
    const prior = field.value
    const count = () => document.querySelectorAll('#thread .msg-user,.task-card,.task-submission').length
    try {
      field.value = over
      field.dispatchEvent(new Event('input', { bubbles: true }))
      const before = count()
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      results.push({ check: 'main oversized Enter', ok: count() === before && field.value === over && document.getElementById('toast-root').textContent.includes(MESSAGE_TOO_LONG) })
    } finally { field.value = prior; field.dispatchEvent(new Event('input', { bubbles: true })) }

    return results
  })()`) as Array<{ check: string, ok: boolean }>
  report(`input boundaries: ${JSON.stringify(results)}`)
  return results.filter(result => !result.ok).map(result => `input boundary ${result.check} did not preserve or bound the draft`)
}
