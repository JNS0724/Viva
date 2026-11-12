import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { openMemoryDb } from '../plugins/memory/lib/store.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { createPersonal } from '../src/backend/personal.ts'
import { scratch } from './fixtures/scratch.js'

/** What the app reports after a turn: memories saved, replaced and sent, and whether memory works. (The MCP servers
 * themselves are viva-mcp's: test/mcp-manager.test.ts, and test/prewarm-runtime.test.js with real dsh.) */

function setup(t, { now } = {}) {
  const { dir, defer } = scratch(t, 'mcp-bridge-')
  const memoryDb = openMemoryDb({ file: path.join(dir, 'memory.db'), now })
  const historyDb = openHistoryDb({ file: path.join(dir, 'history.db') })
  const personal = createPersonal({ memoryDb, historyDb, mcpStore: { list: () => [] }, ...(now ? { now } : {}) })
  defer(() => memoryDb.close())
  defer(() => historyDb.close())
  return { dir, defer, memoryDb, personal }
}

test('the app hears once about what was saved, replaced and sent, including what comes in after the turn', (t) => {
  let clock = 1000
  const { memoryDb, personal } = setup(t, { now: () => clock })
  const old = memoryDb.addMemory({ text: '张三是直属上级', source: 'agent' }).memory
  memoryDb.claimChanges(0, 'conv-0')
  clock = 5000
  memoryDb.addMemory({ text: '周报每周五交给张三', source: 'agent' })
  memoryDb.logInjection({ sessionId: 's-1', turn: 3, fixed: 'first', pushed: [{ text: '回答先给结论', names: ['结论'] }] })
  memoryDb.logInjection({ sessionId: 's-2', turn: 1, fixed: 'first', pushed: [] })

  const report = personal.collect({ conversationId: 'conv-1', sessionId: 's-1' })
  assert.deepEqual(report.memories, ['周报每周五交给张三'])
  assert.deepEqual(report.injected.map((entry) => [entry.turn, entry.fixed, entry.pushed[0].text]), [[3, 'first', '回答先给结论']])
  clock = 6000
  assert.equal(personal.collect({ conversationId: 'conv-1', sessionId: 's-1' }), null, 'nothing new, nothing to tell')

  clock = 8000
  memoryDb.applyExtraction({ add: [{ text: '直属上级是李四', replaces: old.id }], invalidate: [], shown: new Set([old.id]) })
  const late = personal.collect({ conversationId: 'conv-1', sessionId: 's-1' })
  assert.deepEqual([late.memories, late.invalidated], [['直属上级是李四'], ['张三是直属上级']])
})

test('memory counts as working only when the plugin started inside the current dsh', (t) => {
  let clock = 1000
  const { memoryDb, personal } = setup(t, { now: () => clock })
  memoryDb.markPluginStarted()

  assert.equal(personal.mcpStatus(null, 0).memory, false, 'no dsh launched')
  assert.equal(personal.mcpStatus(null, 2000).memory, false, 'started before this launch')
  clock = 2500
  memoryDb.markPluginStarted()
  assert.equal(personal.mcpStatus(null, 2000).memory, true)
})

test('habits read from the history reach the plugin through memory.db', (t) => {
  const { memoryDb, personal } = setup(t)
  assert.deepEqual(personal.habits(), { text: '', samples: 0 })
  assert.equal(memoryDb.habits(), '')
})
