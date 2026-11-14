import { test } from 'node:test'
import assert from 'node:assert/strict'
import { topicHint } from '../src/renderer/topics.ts'

/** The desktop input names the conversation it sends to only when its title says which one it is. */

test('a greeting or a few words do not name a conversation', () => {
  for (const title of ['你好', '你好呀！', '在吗', 'hi', 'Hello!', '帮我看下', '（没有提问）', '(No question)', '（图片或文件）', '  ']) {
    assert.equal(topicHint(title), null, title)
  }
})

test('a title that says what the conversation is about is kept as it is', () => {
  assert.equal(topicHint('整理 11 月周报'), '整理 11 月周报')
  assert.equal(topicHint('把这周的进展整理一下'), '把这周的进展整理一下')
  assert.equal(topicHint('Fix the desktop island layout'), 'Fix the desktop island layout')
})
