import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryHostClient } from '../src/backend/memory-host-client.ts'
import { parseHostMemoryCommand } from '../src/memory/contracts/host.ts'
import type { HostMemoryApi, HostMemoryCaller } from '../src/memory/contracts/host.ts'
import { patchFor } from '../src/backend/dsh-profile.ts'

test('history RPC projects host database rows to the strict occurrence DTO', async () => {
  const inputs: unknown[] = []
  const call: HostMemoryCaller = async (method, input) => {
    inputs.push(parseHostMemoryCommand(method, input))
    return true as HostMemoryApi[typeof method]['output']
  }
  const client = createMemoryHostClient(call, () => undefined)
  const row = { id: 'db-id', seq: 4, receipt: null, at: 15, segmentId: 'segment', sessionId: 'session', sourceId: 'source', role: 'user', text: 'original' }
  await client.allowsProjectHistory(row, undefined, undefined)
  await client.useHistory('session', row)
  assert.equal(inputs.length, 2)
})

test('Viva owner disables the competing stock session-log writer only with memory enabled', () => {
  const plugin = { name: 'viva-memory', dir: '/tmp/viva-memory' }
  const withMemory = patchFor({ plugins: [plugin] })
  assert.match(withMemory, /id: session-log-deepseek\n  name: '@deepseek-ai\/dsh-session-log-deepseek'\n  disabled: false\n  config:\n    enabled: false/)
  assert.doesNotMatch(patchFor({ plugins: [] }), /session-log-deepseek/)
})
