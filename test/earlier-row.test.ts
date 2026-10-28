import { test } from 'node:test'
import assert from 'node:assert/strict'

/** A message in an earlier topic opened before and closed again: shown means its topic is opened again too. */

test('a row drawn in a topic closed again is shown with its topic opened', async () => {
  const globals = globalThis as Record<string, unknown>
  globals.CSS ??= { escape: (text: string) => text }
  const { openEarlierRow } = await import('../src/renderer/view/earlier.ts')
  const fold = { open: false }
  const row = { closest: (selector: string) => (selector === 'details.topic-old' ? fold : null) }
  const container = { querySelector: (selector: string) => (selector === '[data-msg="seg-3"]' ? row : null), querySelectorAll: () => [] }

  const found = openEarlierRow(container as unknown as HTMLElement, 'seg-3')
  assert.equal(found, row)
  assert.equal(fold.open, true, 'its topic is open, so the row is seen')
})
