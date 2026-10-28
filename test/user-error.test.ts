import { test } from 'node:test'
import assert from 'node:assert/strict'
import { userError } from '../src/renderer/user-error.ts'

test('provider failures show actionable Chinese without response bodies, keys, stack frames or raw codes', () => {
  const auth = 'Internal error: turn failed: 401: {"message":"Authentication Fails, Your api key: sk-test-sensitive is invalid"}'
  assert.match(userError(auth), /凭据无效/)
  assert.match(userError('Internal error: turn failed: Connection error.'), /连不上模型/)
  assert.match(userError('429 rate_limit'), /请求太多/)
  assert.match(userError('404 model not found'), /模型暂时不可用/)
  assert.equal(userError('助手意外退出，3 秒后自动重新连接…'), '助手意外退出，3 秒后自动重新连接…')
  assert.match(userError('助手连续意外退出，已停止重试：Internal error: private details'), /已停止重试。请检查模型/)
  for (const raw of [auth, 'ECONNREFUSED 127.0.0.1:9', 'Error: mystery\n    at internal (secret.json:1:2)', '服务器错误 sk-test-sensitive']) {
    assert.doesNotMatch(userError(raw), /sk-test|401|127\.0|Error:|secret\.json/)
  }
})
