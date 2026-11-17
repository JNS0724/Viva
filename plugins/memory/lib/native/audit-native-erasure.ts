import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { openNativeOriginalMaintenance } from '../../../../src/memory/node/native-original-maintenance.ts'
import { compactionInputs } from './compaction-inputs.ts'
import { visitNativeSessionCatalog } from './discover-native-replicas.ts'

type Maintenance = NonNullable<ReturnType<typeof openNativeOriginalMaintenance>>

/** Validate the complete post-publication catalog before acknowledging a native
 * participant. Unattributed compaction errors retain their session obligation. */
export async function auditNativeErasure(root: string, owner: Maintenance) {
  const artifacts: Array<{ session: string, inherited: number, digest: string }> = []
  const uncertain = new Set<string>()
  const context = new Context(), mounted = await context.plugin(jsonl, { root })
  try {
    await visitNativeSessionCatalog(root, context.sessionPersistence, ({ sessionId, inheritedEventCount, events, artifactDigest }) => {
      artifacts.push({ session: sessionId, inherited: inheritedEventCount, digest: artifactDigest })
      const inputs = new Set<string>()
      for (const event of events) {
        const mark = compactionInputs(events, event)
        if (mark) inputs.add(mark.id)
        if (event.type === 'compaction/summary') inputs.add(event.data.compactionId)
        if (event.type === 'compaction/end' && event.data.error !== undefined && !inputs.has(event.data.compactionId)) uncertain.add(sessionId)
      }
    })
  } finally { await mounted.dispose() }
  artifacts.sort((a, b) => a.session.localeCompare(b.session))
  const digest = createHash('sha256').update(JSON.stringify(artifacts)).digest('hex')
  owner.acknowledgeCatalog(digest, uncertain)
}
