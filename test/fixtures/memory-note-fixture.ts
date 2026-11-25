import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { memoryHash } from '../../src/memory/node/memory-store.ts'
import type { MemorySource, MemoryStore } from '../../src/memory/node/memory-store.ts'

export function noteSource(store: MemoryStore, overrides: Partial<MemorySource> = {}): MemorySource {
  const id = randomUUID()
  const author = overrides.author ?? 'user'
  const scope = overrides.scope ?? { kind: 'user' as const }
  const context = overrides.context !== undefined ? overrides.context : null
  const project = overrides.project ?? null
  const profileEligible = overrides.profileEligible ?? (
    (author === 'user' || author === 'answer')
    && scope.kind === 'user'
    && (context === null || context.kind === 'user')
    && project === null
  )
  const source: MemorySource = { id, operation: id, version: 1, conversation: 'conversation', session: 'session',
    scope, context, project, author, sourceKind: overrides.sourceKind ?? (project ? 'project-user' : 'main-human'),
    profileEligible, text: '我在核对发布流程', hash: memoryHash('我在核对发布流程'),
    length: 9, question: null, requestId: null, questionId: null, at: Date.parse('2026-11-14T15:59:00Z'),
    timezone: 'Asia/Shanghai', outcome: 'note-pending', ...overrides }
  store.insertSource(source)
  return source
}

/** Recreate a path move already committed on disk and in the daily notes ledger. */
export function legacyDailyRename(store: MemoryStore, note: { workspace: string, day: string, key: string, path: string }, to: string) {
  const root = join(store.fileRoot, note.workspace)
  mkdirSync(dirname(join(root, to)), { recursive: true })
  renameSync(join(root, note.path), join(root, to))
  const index = join(root, `daily/${note.day}.md`)
  writeFileSync(index, readFileSync(index, 'utf8').replaceAll(note.path, to))
  store.tx(() => {
    store.db.prepare('UPDATE memory_daily_notes SET path=?, revision=revision+1 WHERE key=?').run(to, note.key)
  })
}
