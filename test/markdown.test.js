import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeHref } from '../src/renderer/view/markdown.ts'

/** The DOM side is checked by the relaunch smoke run (src/main/smoke.js checkMarkdown). */
test('an answer may link only to web and mail addresses', () => {
  assert.equal(safeHref('https://example.com/spec'), 'https://example.com/spec')
  assert.equal(safeHref('mailto:a@example.com'), 'mailto:a@example.com')
  for (const href of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'relative/path', '', undefined]) assert.equal(safeHref(href), null)
})
