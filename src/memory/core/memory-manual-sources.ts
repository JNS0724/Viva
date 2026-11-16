import type { DocumentSourceRef } from './ports/documents.ts'
import type { MemorySource, MemoryStore } from './ports/store.ts'
import { documentSourceRestricted } from './memory-document-restrictions.ts'

/** A whole-body edit may reuse any word of the accepted projection. Its source stays
 * dependent on the precise proof it copied, including if that source is read in another file. */
export function manualFileCopyRefs(refs: readonly DocumentSourceRef[], store: Pick<MemoryStore, 'readSource' | 'manualFileCopies'>,
  token: (source: MemorySource) => string): DocumentSourceRef[] {
  const copies = new Map<string, DocumentSourceRef>()
  const pending = [...refs]
  for (const ref of pending) for (const copy of store.manualFileCopies(ref.id)) {
    if (copies.has(copy.source) || !documentSourceRestricted(copy.reference, [ref])) continue
    const source = store.readSource(copy.source)
    if (!source?.text || !source.hash || source.withdrawn) continue
    const dependency = { id: source.id, token: token(source) }
    copies.set(copy.source, dependency)
    pending.push(dependency)
  }
  return [...copies.values()]
}
