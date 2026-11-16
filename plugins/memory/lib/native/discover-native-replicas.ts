import { createHash } from 'node:crypto'
import { readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { memoryMessageText, memoryOriginalContentDigest } from '../context-recovery.ts'
import type { ReplicaCandidate } from './project-native-originals.ts'
import { verifyCompleteArtifact } from './verify-native-artifact.ts'

const artifactName = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/u

/** The provider may omit an artifact with a broken header from its catalog. */
async function physicalArtifacts(root: string) {
  const names = new Set<string>()
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (project.isSymbolicLink()) throw new Error('Native project path is a link')
    if (!project.isDirectory()) continue
    const projectDir = path.join(root, project.name)
    for (const session of await readdir(projectDir, { withFileTypes: true })) {
      if (session.isSymbolicLink()) throw new Error('Native session path is a link')
      if (!session.isDirectory()) continue
      const directory = path.join(projectDir, session.name)
      for (const artifact of await readdir(directory, { withFileTypes: true })) {
        if (!artifactName.test(artifact.name)) continue
        if (!artifact.isFile()) throw new Error('Native log path is not a regular file')
        names.add(path.join(directory, artifact.name))
      }
    }
  }
  return names
}

type NativeCatalogItem = { sessionId: SessionId, inheritedEventCount: number, events: readonly SessionEvent[] }

/** Scan the actual durable artifacts, including branches never opened by the memory owner. */
export async function visitNativeSessionCatalog(root: string, persistence: SessionPersistence, visit: (item: NativeCatalogItem) => void) {
  const files = await physicalArtifacts(await realpath(root))
  for (const { header, formatStatus, location } of await persistence.list()) {
    if (formatStatus !== 'current' || location?.kind !== 'jsonl' || !files.delete(await realpath(location.path))) {
      throw new Error('Unverified historical native log can contain a replica')
    }
    const handle = await persistence.open(header.id, 'read')
    try {
      const { events } = await handle.read()
      const fileDigest = createHash('sha256').update(await readFile(location.path)).digest('hex')
      await verifyCompleteArtifact(location.path, fileDigest, location.path.endsWith('.zstd'), events.length)
      visit({ sessionId: header.id, inheritedEventCount: handle.inheritedEventCount, events })
    } finally { await handle.close() }
  }
  if (files.size) throw new Error('The native catalog omitted physical session files')
}

/** The original identity is shared by forked events, even before a child is admitted. */
export async function discoverNativeOriginalCopies(
  root: string,
  persistence: SessionPersistence,
  messageIds: ReadonlySet<string>,
  verify: (candidate: ReplicaCandidate & { sessionId: SessionId }) => boolean,
): Promise<Map<SessionId, ReadonlySet<string>>> {
  const copies = new Map<SessionId, ReadonlySet<string>>()
  await visitNativeSessionCatalog(root, persistence, ({ sessionId, events }) => {
    const messages = new Set<string>()
    for (const event of events) {
      const items = event.type === 'user/message' ? [event.data] : event.type === 'agent/inbox/spliced' ? event.data.inserted : []
      for (const item of items) {
        const messageId = String(item.id)
        if (!messageIds.has(messageId)) continue
        if (item.source.kind !== 'user' || !verify({ messageId, sessionId, wireText: memoryMessageText(item), contentDigest: memoryOriginalContentDigest(item) })) {
          throw new Error('Native replica conflicts with its original proof')
        }
        messages.add(messageId)
      }
    }
    if (messages.size) copies.set(sessionId, messages)
  })
  return copies
}
