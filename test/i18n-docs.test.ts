import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkDocumentation, digest } from '../scripts/check-i18n.ts'

test('all project document translations have reviewed hashes and working local file links', () => {
  assert.deepEqual(checkDocumentation(), [])
})
test('translation freshness is independent of checkout line endings', () => {
  assert.equal(digest('one\r\ntwo\r\n'), digest('one\ntwo\n'))
  assert.notEqual(digest('one\ntwo'), digest('one\nchanged'))
})
