import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileName, splitFiles, withFiles } from '../src/shared/attachments.ts'
import { initialState, reduce } from '../src/renderer/state.js'

test('files go with a question as a block at its end, and come back out of it', () => {
  const prompt = withFiles('总结', ['/Users/me/文稿/Q3 周报.docx', 'C:\\Users\\me\\报价单.xlsx'])
  assert.equal(prompt, '总结\n\n附带的文件（本机路径）：\n- /Users/me/文稿/Q3 周报.docx\n- C:\\Users\\me\\报价单.xlsx')
  assert.deepEqual(splitFiles(prompt), { text: '总结', files: ['/Users/me/文稿/Q3 周报.docx', 'C:\\Users\\me\\报价单.xlsx'] })
  assert.equal(withFiles('在吗', []), '在吗')
  assert.deepEqual(splitFiles('在吗'), { text: '在吗', files: [] })
})

test('a question that only looks like it names files is left as it was typed', () => {
  const typed = '看看这个\n\n附带的文件（本机路径）：\n我忘了附'
  assert.deepEqual(splitFiles(typed), { text: typed, files: [] })
})

test('a file is shown by its name, from a path of either platform', () => {
  assert.equal(fileName('/Users/me/Q3 周报.docx'), 'Q3 周报.docx')
  assert.equal(fileName('C:\\Users\\me\\报价单.xlsx'), '报价单.xlsx')
})

test('a question asked on the desktop island says so in the thread', () => {
  const asked = reduce(initialState, { type: 'user_prompt', text: '总结', at: 1, via: 'island' })
  assert.equal(asked.messages.at(-1).via, 'island')
  assert.equal('via' in reduce(initialState, { type: 'user_prompt', text: '在吗', at: 1 }).messages.at(-1), false)
})
