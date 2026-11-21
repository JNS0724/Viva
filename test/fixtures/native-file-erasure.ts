import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { MemoryManagedFileIdentity, MemoryFileMutationResult } from '../../src/memory/contracts/file-management.ts'
import type { HostMemoryApi } from '../../src/memory/contracts/host.ts'
import type { MemoryHostEffect } from '../../src/memory/contracts/service.ts'
import type { TextSpan } from '../../src/memory/contracts/text-spans.ts'
import type { openMemoryOwner } from '../../src/memory/node/owner.ts'
import { openMemoryStore } from '../../src/memory/node/memory-store.ts'
import { createOwnerNativeOriginals } from '../../src/memory/node/owner-native-originals.ts'
import { memorySourceToken } from '../../src/memory/node/source-identity.ts'

export type ErasableNativeFile = {
  identity: MemoryManagedFileIdentity
  seedId: string
  editId: string
  receipt: MemoryFileMutationResult
}

/** Create a manual file with parent lineage via real production createFile + editFile,
 * so withdrawing its seed source produces a real dependent range erasure. */
export async function createErasableNativeFile(
  owner: ReturnType<typeof openMemoryOwner>,
  text: string,
): Promise<ErasableNativeFile> {
  const seedId = randomUUID()
  const created = await owner.handleHost('createFile', {
    args: [{ operationId: seedId, text: 'Initial draft note before revision.' }],
  }) as HostMemoryApi['createFile']['output']
  const detail = await owner.handleHost('readFile', { args: [created.identity] }) as HostMemoryApi['readFile']['output']
  if (!detail) throw new Error('Expected created manual file to be readable')
  const editId = randomUUID()
  const receipt = await owner.handleHost('editFile', {
    args: [{ operationId: editId, identity: created.identity, version: detail.version, text }],
  }) as HostMemoryApi['editFile']['output']
  return { identity: created.identity, seedId, editId, receipt }
}

/** Trigger dependent manual-file erasure through the real prepareSourceChange + commitSourceChange path. */
export async function withdrawSource(
  owner: ReturnType<typeof openMemoryOwner>,
  { conversation, ids, onlySources = true, operationId = randomUUID() }: {
    conversation: string
    ids: string[]
    onlySources?: boolean
    operationId?: string
  },
) {
  const { ticket } = await owner.handleHost('prepareSourceChange', {
    operationId,
    conversation,
    onlySources,
    ids,
  }) as { ticket: string }
  return owner.handleHost('commitSourceChange', { operationId, ticket })
}

export async function withdrawNativeFile(
  owner: ReturnType<typeof openMemoryOwner>,
  file: Pick<ErasableNativeFile, 'identity' | 'seedId'>,
  operationId: string = randomUUID(),
) {
  return withdrawSource(owner, {
    operationId,
    conversation: `manual-file:${file.identity.workspace}`,
    ids: [file.seedId],
    onlySources: true,
  })
}

/** Seed a partial-span original erasure plan directly in memory.db for low-level
 * eraseColdNativeCopies tests covering wire-cut and recovery-marker projection. */
export function recordPartialOriginalErasure(
  memoryRoot: string,
  { operationId, sourceId, spans, extraSessions = [], hostNamespace }: {
    operationId: string
    sourceId: string
    spans: TextSpan[]
    extraSessions?: string[]
    hostNamespace?: string
  },
) {
  const store = openMemoryStore(join(memoryRoot, 'memory.db'))
  try {
    const source = store.readSource(sourceId)
    if (!source?.text || !source.hash) throw new Error(`Missing canonical source ${sourceId}`)
    const cut = { id: sourceId, token: memorySourceToken(source), spans }
    const erased = store.eraseFileSource(cut, source.version)
    if (!erased) throw new Error(`Failed to erase range on source ${sourceId}`)
    const afterHash = store.readSource(sourceId)?.hash
    if (!afterHash) throw new Error(`Missing afterHash for source ${sourceId}`)
    const ranges = [{ sourceId, revision: source.version, length: source.length, hash: source.hash, afterHash, spans }]
    const sessions = new Set(extraSessions)
    if (source.session) sessions.add(source.session)
    for (const row of store.db.prepare('SELECT session FROM owner_occurrences WHERE source=?').all(sourceId)) {
      sessions.add(String(row.session))
    }
    const originals = createOwnerNativeOriginals(store.db).replicas(ranges)
    store.db.prepare('UPDATE owner_aliases SET payload=NULL,revoked=1 WHERE source=?').run(sourceId)
    store.db.prepare('INSERT INTO owner_file_native_erasures VALUES (?,?)').run(
      operationId,
      JSON.stringify({ sessions: [...sessions], ranges, ...(originals.length ? { originals } : {}) }),
    )
    if (hostNamespace) {
      const effect: MemoryHostEffect = {
        effectId: operationId,
        causeOperationId: operationId,
        revision: store.nextRevision(),
        hostNamespace,
        kind: 'erase-file-copies',
        sessions: [...sessions],
        ...(sessions.size ? { traceSessions: [...sessions] } : {}),
        sources: [{ namespace: 'canonical', sourceId, revision: source.version }],
        ranges,
      }
      store.db.prepare('INSERT INTO owner_host_effects(id,payload) VALUES (?,?)').run(operationId, JSON.stringify(effect))
    }
  } finally {
    store.close()
  }
}
