import type { DatabaseSync } from 'node:sqlite'
import type { DocumentSourceRef } from '../core/ports/documents.ts'
import type { FileUseRestriction, FileUseTarget, MemoryFileRestrictions } from '../core/ports/file-restrictions.ts'
import { memoryFileMutationResult } from '../contracts/file-management.ts'
import { memorySourceReference } from '../contracts/service.ts'

interface Row {
  id: string
  kind: FileUseTarget['kind']
  workspace: string
  target: string
  content_revision: string
  usage_version: number
  sources: string
}
const refs = (row: { sources: string }): DocumentSourceRef[] => JSON.parse(row.sources) as DocumentSourceRef[]

/** The owner opens this ledger on the same database as the file metadata and job queue. */
export function openMemoryFileRestrictions(db: DatabaseSync): MemoryFileRestrictions {
  const oldRestrictions = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_document_use_restrictions'").get()
  const oldDaily = db.prepare(`SELECT 1 FROM pragma_table_info('memory_daily_notes') WHERE name='file_revision' AND "notnull"=1`).get()
  if (oldRestrictions || oldDaily) throw new Error('Memory file layout is incompatible; use a fresh memory data directory')
  db.exec(`CREATE TABLE IF NOT EXISTS memory_file_use_restrictions (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, workspace TEXT NOT NULL, target TEXT NOT NULL,
    content_revision TEXT NOT NULL, usage_version INTEGER NOT NULL, sources TEXT NOT NULL, snapshot TEXT
  );
  CREATE INDEX IF NOT EXISTS memory_file_use_restrictions_target ON memory_file_use_restrictions(workspace,kind,target);
  CREATE TABLE IF NOT EXISTS memory_file_use_commands (
    operation TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, sources TEXT NOT NULL
  )`)
  const targetRows = db.prepare(`SELECT id,kind,workspace,target,content_revision,usage_version,sources
    FROM memory_file_use_restrictions WHERE workspace=? AND kind=? AND target=? ORDER BY rowid`)
  const workspaceRows = db.prepare('SELECT kind,workspace,target,sources FROM memory_file_use_restrictions WHERE workspace=? ORDER BY rowid')
  const insert = db.prepare('INSERT INTO memory_file_use_restrictions VALUES (?,?,?,?,?,?,?,?)')
  const release = db.prepare('DELETE FROM memory_file_use_restrictions WHERE workspace=? AND kind=? AND target=? AND id=?')
  const clearTarget = db.prepare('DELETE FROM memory_file_use_restrictions WHERE workspace=? AND kind=? AND target=?')
  return {
    forTarget(target) {
      return (targetRows.all(target.workspace, target.kind, target.key) as unknown as Row[]).map(row => ({
        id: row.id, workspace: row.workspace, kind: row.kind, key: row.target,
        contentRevision: row.content_revision, usageVersion: row.usage_version, sources: refs(row),
      }))
    },
    sources(workspace, except) {
      return (workspaceRows.all(workspace) as unknown as Pick<Row, 'kind' | 'workspace' | 'target' | 'sources'>[])
        .filter(row => !except || row.workspace !== except.workspace || row.kind !== except.kind || row.target !== except.key)
        .flatMap(refs)
    },
    add(input, snapshot) {
      insert.run(input.id, input.kind, input.workspace, input.key, input.contentRevision, input.usageVersion, JSON.stringify(input.sources), snapshot ?? null)
    },
    snapshot(target, id) {
      const row = db.prepare('SELECT snapshot FROM memory_file_use_restrictions WHERE workspace=? AND kind=? AND target=? AND id=?')
        .get(target.workspace, target.kind, target.key, id)
      return typeof row?.snapshot === 'string' ? row.snapshot : null
    },
    release(target, id) { return release.run(target.workspace, target.kind, target.key, id).changes === 1 },
    removeTarget(target) { clearTarget.run(target.workspace, target.kind, target.key) },
    withdrawSource(sourceId) {
      const rows = db.prepare('SELECT id,sources FROM memory_file_use_restrictions').all() as Array<{ id: string, sources: string }>
      for (const row of rows) {
        const current = refs(row), remaining = current.filter(ref => ref.id !== sourceId)
        if (remaining.length === current.length) continue
        if (remaining.length) db.prepare('UPDATE memory_file_use_restrictions SET sources=?,snapshot=NULL WHERE id=?').run(JSON.stringify(remaining), row.id)
        else db.prepare('DELETE FROM memory_file_use_restrictions WHERE id=?').run(row.id)
      }
    },
    receipt(operationId) {
      const row = db.prepare('SELECT fingerprint,result,sources FROM memory_file_use_commands WHERE operation=?').get(operationId)
      return row ? { fingerprint: String(row.fingerprint), result: memoryFileMutationResult.parse(JSON.parse(String(row.result))),
        sources: memorySourceReference.array().parse(JSON.parse(String(row.sources))) } : null
    },
    complete(operationId, { fingerprint, result, sources }) {
      db.prepare('INSERT INTO memory_file_use_commands VALUES (?,?,?,?)').run(operationId, fingerprint, JSON.stringify(result), JSON.stringify(sources))
    },
  }
}
