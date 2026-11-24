import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { APP_DB_PRAGMAS, transaction } from './sqlite.ts'
import { MEMORY_CONTRACT, memoryScope } from '../contracts/memory-contract.ts'
import type { DocumentSourceRef } from '../core/ports/documents.ts'
import type { MemorySource } from '../contracts/records.ts'
import { memoryScopeKey } from '../core/scope.ts'
export { memoryScopeKey } from '../core/scope.ts'
export type { MemorySource, MemoryFileDependency } from '../contracts/records.ts'

type SourceRow = Omit<MemorySource, 'scope' | 'context' | 'project' | 'requestId' | 'questionId'> & {
  scope: string, context: string | null, project: string | null, request_id: string | null, question_id: string | null
}
export const memoryHash = (text: string) => createHash('sha256').update(text).digest('hex')

const SCHEMA = `
  CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE memory_session_cursors (session TEXT PRIMARY KEY, next_seq INTEGER NOT NULL);
  CREATE TABLE memory_sources (
    id TEXT PRIMARY KEY, operation TEXT NOT NULL, version INTEGER NOT NULL,
    conversation TEXT, session TEXT, scope TEXT NOT NULL, context TEXT, project TEXT, author TEXT NOT NULL,
    text TEXT, hash TEXT, length INTEGER NOT NULL, question TEXT, request_id TEXT, question_id TEXT, at INTEGER NOT NULL, timezone TEXT NOT NULL,
    outcome TEXT NOT NULL, UNIQUE(operation, version)
  );
  CREATE INDEX memory_sources_conversation ON memory_sources(conversation);
  CREATE TABLE memory_manual_file_lineage (
    source TEXT NOT NULL, parent TEXT NOT NULL, reference TEXT NOT NULL, PRIMARY KEY(source,parent)
  );
  CREATE TABLE memory_commands (key TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, result INTEGER);
`

export function openMemoryStore(file: string, now = Date.now) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version !== MEMORY_CONTRACT && (version !== 0 || db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table'").get())) {
      throw Object.assign(new Error('memory.db has an incompatible contract version'), { code: 'unknown_version' })
    }
    db.exec(APP_DB_PRAGMAS)
    if (version === 0) transaction(db, () => {
      db.exec(SCHEMA)
      db.exec(`PRAGMA user_version = ${MEMORY_CONTRACT}`)
      db.prepare('INSERT INTO memory_meta (key,value) VALUES (?,?)').run('secret', randomBytes(32).toString('hex'))
      db.prepare('INSERT INTO memory_meta (key,value) VALUES (?,?)').run('created_at', String(now()))
    })
  } catch (error) { db.close(); throw error }
  const meta = (key: string) => (db.prepare('SELECT value FROM memory_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
  const setMeta = (key: string, value: string) => db.prepare('INSERT OR REPLACE INTO memory_meta VALUES (?,?)').run(key, value)
  const revision = () => Number(meta('revision') ?? 0)
  const epoch = () => Number(meta('epoch') ?? 0)
  const tx = <T>(work: () => T): T => transaction(db, work)
  const nextRevision = (invalidate = false) => {
    const next = revision() + 1
    setMeta('revision', String(next))
    if (invalidate) setMeta('epoch', String(next))
    return next
  }
  const sourceById = db.prepare('SELECT * FROM memory_sources WHERE id=?')
  const readSource = (id: string): MemorySource | null => {
    const row = sourceById.get(id) as SourceRow | undefined
    if (!row) return null
    return { ...row, requestId: row.request_id, questionId: row.question_id,
      scope: memoryScope.parse(JSON.parse(row.scope)), context: row.context ? memoryScope.parse(JSON.parse(row.context)) : null,
      project: row.project ? memoryScope.parse(JSON.parse(row.project)) : null }
  }
  const insertSource = (source: MemorySource) => db.prepare(`INSERT INTO memory_sources
    (id, operation, version, conversation, session, scope, context, project, author, text, hash, length, question, request_id, question_id, at, timezone, outcome)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(source.id, source.operation, source.version, source.conversation, source.session,
    memoryScopeKey(source.scope), source.context ? memoryScopeKey(source.context) : null, source.project ? memoryScopeKey(source.project) : null, source.author, source.text, source.hash, source.length,
    source.question, source.requestId, source.questionId, source.at, source.timezone, source.outcome)
  function insertManualFileSource(source: MemorySource, parents: readonly DocumentSourceRef[]) {
    tx(() => {
      insertSource(source)
      const insert = db.prepare('INSERT INTO memory_manual_file_lineage VALUES(?,?,?)')
      for (const parent of parents) insert.run(source.id, parent.id, JSON.stringify(parent))
    })
  }
  const parentsOfManualFile = db.prepare('SELECT reference FROM memory_manual_file_lineage WHERE source=? ORDER BY parent')
  const manualFileParents = (source: string) => parentsOfManualFile.all(source).map(row => JSON.parse(String(row.reference)) as DocumentSourceRef)
  const outcome = (id: string, state: string) => db.prepare('UPDATE memory_sources SET outcome=? WHERE id=?').run(state, id)
  const command = (key: string) => db.prepare('SELECT kind,payload,result FROM memory_commands WHERE key=?').get(key) as { kind: string, payload: string, result: number | null } | undefined
  const recordCommand = (key: string, kind: string, payload: string, result: number | null) =>
    db.prepare('INSERT INTO memory_commands VALUES (?,?,?,?)').run(key, kind, payload, result)
  let temporaryFileRoot: string | undefined
  return { get fileRoot() {
    return file === ':memory:' ? temporaryFileRoot ??= fs.mkdtempSync(path.join(tmpdir(), 'viva-memory-files-')) : path.join(path.dirname(file), 'memory-files')
  }, db, tx, revision, epoch, nextRevision,
    readSource, insertSource, insertManualFileSource, manualFileParents,
    outcome, meta, setMeta, command, recordCommand,
    close() { try { db.close() } finally { if (temporaryFileRoot) fs.rmSync(temporaryFileRoot, { recursive: true, force: true }) } }
  }
}
export type MemoryStore = ReturnType<typeof openMemoryStore>
