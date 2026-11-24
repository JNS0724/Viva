import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHostMemoryCommand } from '../src/memory/contracts/host.ts'
import type { HostMemoryApi, HostMemoryCaller } from '../src/memory/contracts/host.ts'
import { patchFor } from '../src/backend/dsh-profile.ts'


test('Viva owner disables the competing stock session-log writer only with memory enabled', () => {
  const plugin = { name: 'viva-memory', dir: '/tmp/viva-memory' }
  const withMemory = patchFor({ plugins: [plugin] })
  assert.match(withMemory, /id: session-log-deepseek\n  name: '@deepseek-ai\/dsh-session-log-deepseek'\n  disabled: false\n  config:\n    enabled: false/)
  assert.doesNotMatch(patchFor({ plugins: [] }), /session-log-deepseek/)
})
