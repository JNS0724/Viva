import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { createPersonal } from '../src/backend/personal.ts'

test('personal context reports habits from the history', t => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const personal = createPersonal({ historyDb: openHistoryDb({ db }), mcpStore: { list: () => [] } })
  assert.deepEqual(personal.habits(), { text: '', samples: 0 })
})

test('personal settings expose the manager status and servers Viva could not launch', t => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const personal = createPersonal({ historyDb: openHistoryDb({ db }), mcpStore: { list: () => [{
    name: 'missing', type: 'stdio', command: 'viva-test-no-such-binary', args: [], url: '', env: {}, headers: {}, missing: [],
  }] } })

  assert.deepEqual(personal.mcpServers(), [])
  const status = personal.mcpStatus({ mcp: {
    active: ['connected'], connecting: [{ name: 'starting', reason: 'loading' }], dropped: [{ name: 'error', reason: 'failed' }],
  } })
  assert.deepEqual(status.active, ['connected'])
  assert.deepEqual(status.connecting, [{ name: 'starting', reason: 'loading' }])
  assert.deepEqual(status.dropped.map(server => server.name), ['error', 'missing'])
})
