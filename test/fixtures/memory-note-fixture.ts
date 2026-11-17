import { randomUUID } from 'node:crypto'
import { memoryHash } from '../../src/memory/node/memory-store.ts'
import type { MemorySource, MemoryStore } from '../../src/memory/node/memory-store.ts'

export function noteSource(store: MemoryStore, overrides: Partial<MemorySource> = {}): MemorySource {
  const id = randomUUID()
  const source: MemorySource = { id, operation: id, version: 1, conversation: 'conversation', session: 'session',
    scope: { kind: 'user' }, context: null, project: null, author: 'user', text: '我在核对发布流程', hash: memoryHash('我在核对发布流程'),
    length: 9, question: null, requestId: null, questionId: null, at: Date.parse('2026-11-14T15:59:00Z'),
    timezone: 'Asia/Shanghai', outcome: 'note-pending', withdrawn: false, ...overrides }
  store.insertSource(source)
  return source
}
