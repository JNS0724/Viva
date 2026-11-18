import { createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { parseHostMemoryCommand } from '../../src/memory/contracts/host.ts'
import type { MemoryFileForgetRequest, MemoryFileMutationResult } from '../../src/memory/contracts/file-management.ts'
import type { openMemoryOwner } from '../../src/memory/node/owner.ts'

/** An older installation persisted this intent before its user-approved erasure
 * finished. Only those pre-upgrade operations still perform source cleanup. */
export function resumeLegacyFileErasure(owner: ReturnType<typeof openMemoryOwner>, database: DatabaseSync | string,
  request: MemoryFileForgetRequest): Promise<MemoryFileMutationResult> {
  const db = typeof database === 'string' ? new DatabaseSync(database) : database
  try {
    const command = parseHostMemoryCommand('forgetFile', { args: [request] })
    const secret = db.prepare("SELECT value FROM memory_meta WHERE key='secret'").get()?.value
    if (typeof secret !== 'string') throw new Error('Missing fixture owner key')
    const fingerprint = createHmac('sha256', secret).update(JSON.stringify(command)).digest('hex')
    db.prepare("INSERT OR IGNORE INTO owner_operations VALUES (?,?,'running',?,NULL)").run(request.operationId,
      fingerprint, JSON.stringify({ command, sources: [], sessions: [] }))
  } finally { if (typeof database === 'string') db.close() }
  return owner.handleHost('forgetFile', { args: [request] }) as Promise<MemoryFileMutationResult>
}
