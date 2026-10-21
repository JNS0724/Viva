import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sideEffectsOf } from '../src/main/side-effects.js'

const tool = (at, name, args, status = 'completed') => ({ seq: at, at, kind: 'tool', callId: `c${at}`, name, args, status })

test('what a path did to the computer from a moment on: files written (how often) and commands run', () => {
  const steps = [
    tool(5, 'write', { file_path: '/w/early.md' }),
    { seq: 10, at: 10, kind: 'thought', text: '想' },
    tool(11, 'read', { file_path: '/w/notes.md' }),
    tool(12, 'write', { file_path: '/w/summary.md' }),
    tool(13, 'edit', { file_path: '/w/summary.md' }),
    tool(14, 'bash', { command: 'git add summary.md' }),
    tool(15, 'bash', { command: 'rm -rf build' }, 'failed'),
    tool(16, 'web_fetch', { url: 'https://example.com' }),
  ]

  assert.deepEqual(sideEffectsOf(steps, 10), {
    files: [{ path: '/w/summary.md', times: 2 }],
    commands: ['git add summary.md'],
  })
  assert.deepEqual(sideEffectsOf(steps, 100), { files: [], commands: [] })
})

test('a long command is cut, and the list stays short', () => {
  const steps = Array.from({ length: 30 }, (_, i) => tool(i + 1, 'bash', { command: `echo ${'x'.repeat(i === 0 ? 300 : 3)} ${i}` }))
  const { commands } = sideEffectsOf(steps, 0)
  assert.equal(commands.length, 8)
  assert.ok(commands[0].length <= 121 && commands[0].endsWith('…'))
})
