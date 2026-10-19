import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exportFileName, toMarkdown } from '../src/main/history-export.js'

test('toMarkdown writes the title, when and with which model, then the questions and answers', () => {
  // Arrange
  const conversation = { title: '周报整理', updatedAt: new Date(2026, 9, 18, 9, 5).getTime(), model: 'DeepSeek-V4-Pro' }
  const messages = [
    { role: 'user', text: '帮我整理周报', receipt: null },
    { role: 'assistant', text: '第一项\n第二项', receipt: { ms: 1, tools: 0, thoughts: 0, stopReason: 'end_turn' } },
    { role: 'note', text: '已停止本轮任务。', receipt: null },
  ]

  // Act
  const markdown = toMarkdown(conversation, messages)

  // Assert
  assert.equal(markdown, [
    '# 周报整理',
    '',
    '- 时间：2026-10-18 09:05',
    '- 模型：DeepSeek-V4-Pro',
    '',
    '---',
    '',
    '**你**',
    '',
    '帮我整理周报',
    '',
    '**助手**',
    '',
    '第一项\n第二项',
    '',
    '> 已停止本轮任务。',
    '',
  ].join('\n'))
})

test('toMarkdown leaves out an unknown model, and export names are safe file names', () => {
  assert.equal(toMarkdown({ title: '', updatedAt: 0, model: null }, []).split('\n')[0], '# 对话')
  assert.equal(toMarkdown({ title: 'x', updatedAt: 0, model: null }, []).includes('模型'), false)
  assert.equal(exportFileName('  a/b:c*?"<>|  '), 'a-b-c-.md')
  assert.equal(exportFileName('...'), '对话.md')
})
