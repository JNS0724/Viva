import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ROWS, parseTable } from '../src/renderer/csv.ts'

test('fields split on the delimiter; quotes hold delimiters, quotes and line breaks', () => {
  assert.deepEqual(parseTable('a,b,c\n1,"x, y","say ""hi"""\n2,"two\nlines",\n', ','), {
    rows: [['a', 'b', 'c'], ['1', 'x, y', 'say "hi"'], ['2', 'two\nlines', '']], more: 0,
  })
  assert.deepEqual(parseTable('a\tb\r\n1\t2', '\t').rows, [['a', 'b'], ['1', '2']])
  assert.deepEqual(parseTable('a,b\n1', ',').rows, [['a', 'b'], ['1']], 'rows may differ in length')
  assert.deepEqual(parseTable('007,=1+1', ',').rows, [['007', '=1+1']], 'values stay as written')
})

test('a long table stops at the row limit and says how many rows are left', () => {
  const text = Array.from({ length: MAX_ROWS + 5 }, (_, i) => `r${i}`).join('\n')
  const table = parseTable(text, ',')
  assert.equal(table.rows.length, MAX_ROWS)
  assert.equal(table.more, 5)
})
