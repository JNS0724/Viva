import assert from 'node:assert/strict'
import { writeSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import { createMemoryRuntime } from '../../src/backend/memory-runtime.ts'
import { openMemoryStore } from '../../src/memory/node/memory-store.ts'
import { crashAt } from './memory-crash-process.ts'

export const memoryCrashCheckpoints = [
  'before-intake-commit', 'after-intake-commit', 'after-ack', 'during-calculation', 'before-result-commit', 'after-result-commit',
] as const
export const origin = { conversation: 'closed-conversation', session: 'closed-session' }
export const text = '以后我的咖啡都加燕麦奶'
export const extraction = JSON.stringify({ proposals: [{ spans: [{ start: 0, end: text.length }],
  kind: 'preference', scope: 'user', modality: 'asserted', attribution: 'self', keywords: [],
}] })

if (import.meta.main) {
  const [, , checkpoint, file, id] = process.argv
  if (!checkpoint || !file || !id) throw new Error('Expected a crash point, database file and source ID')
  const store = openMemoryStore(file)
  const memory = createMemoryRuntime({
    store,
    route: () => ({ provider: 'fixture', model: 'fixture' }),
    compute: async job => {
      assert.equal(job.stage, 'extract')
      assert.equal(job.sourceId, id)
      if (checkpoint === 'during-calculation') {
        await setImmediate()
        assert.equal(store.db.isTransaction, false)
        crashAt(checkpoint)
      }
      return extraction
    },
    validateDispatch: () => {
      if (checkpoint === 'before-result-commit') {
        assert.equal(store.db.isTransaction, true)
        assert.equal(store.readSource(id)?.outcome, 'accepted')
        crashAt(checkpoint)
      }
    },
    changed: () => {
      if (checkpoint === 'after-result-commit') {
        assert.equal(store.db.isTransaction, false)
        crashAt(checkpoint)
      }
    },
    quiesce: async () => {},
  })
  if (checkpoint === 'before-intake-commit') store.tx(() => {
    memory.accept(text, origin, id)
    crashAt(checkpoint)
  })
  const receipt = memory.accept(text, origin, id)
  if (checkpoint === 'after-intake-commit') crashAt(checkpoint)
  writeSync(1, JSON.stringify(receipt) + '\n')
  if (checkpoint === 'after-ack') crashAt(checkpoint)
  await memory.wake()
  throw new Error('The crash fixture did not reach the requested checkpoint')
}
