import test from 'node:test'
import assert from 'node:assert/strict'
import { PROMPT_HEADS, permissionCard, promptButtons } from '../src/renderer/prompt-card.js'

const option = (optionId, kind) => ({ optionId, name: optionId, kind })

test('the same heads on both hosts, for what waits on the user', () => {
  assert.deepEqual(PROMPT_HEADS, { permission: '需要你确认', question: '需要你回答', secret: '需要你填写' })
})

test('the first allowing option is the main one; the others are secondary', () => {
  const roles = promptButtons([option('ok', 'allow_once'), option('always', 'allow_always'), option('no', 'reject_once')]).map((item) => item.role)
  assert.deepEqual(roles, ['primary', 'secondary', 'secondary'])
  assert.deepEqual(promptButtons([option('no', 'reject_once'), option('always', 'allow_always')]).map((item) => item.role), ['secondary', 'primary'])
  assert.deepEqual(promptButtons([option('no', 'reject_once')]).map((item) => item.role), ['secondary'], 'no allowing option, no main one')
})

test('a command is titled as one, its text shown below rather than in the title', () => {
  const card = permissionCard({ title: '运行命令：rm -rf build', rawInput: { command: 'rm -rf build' } })
  assert.deepEqual(card, { title: '运行命令', detail: 'rm -rf build', command: 'rm -rf build' })
})

test('anything else keeps its title, with its arguments as the detail and no command line', () => {
  const card = permissionCard({ title: '写入 summary.md', rawInput: { path: 'summary.md', content: 'x' } })
  assert.equal(card.title, '写入 summary.md')
  assert.equal(card.command, '')
  assert.match(card.detail, /summary\.md/)
  assert.deepEqual(permissionCard({ title: '发送邮件' }), { title: '发送邮件', detail: '', command: '' })
})
