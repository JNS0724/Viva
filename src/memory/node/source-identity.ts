import type { MemorySource } from '../core/ports/store.ts'
import { memoryFileRevision } from './memory-file-store.ts'

export const memorySourceWorkspace = (source: MemorySource): string => memoryFileRevision(JSON.stringify([source.scope, source.context, source.project ?? null]))
export const memorySourceToken = (source: MemorySource): string => memoryFileRevision(JSON.stringify([
  source.id, source.version, source.hash, source.text, source.author, source.at, source.timezone,
  source.session, source.conversation, source.question, source.scope, source.context, source.project ?? null,
]))
