import { realpath } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { openNativeOriginalMaintenance } from '../../../../src/memory/node/native-original-maintenance.ts'
import { discoverNativeOriginalCopies } from './discover-native-replicas.ts'
import { rewriteColdNativeSession } from './native-cold-rewrite.ts'
import { clearNativeProjections } from './projection-cache.ts'
import { projectNativeOriginals } from './project-native-originals.ts'
import { eraseNativeOutputs, type NativeOutputTrace } from './erase-native-outputs.ts'

export class PendingNativePublication extends Error {}

/** Run inside the host's cold lifecycle gate with no live persistence readers. */
export async function eraseColdNativeCopies({ memoryRoot, sessionsRoot, storageRoot, hostNamespace, isCold, trace }: {
  memoryRoot: string, sessionsRoot: string, storageRoot: string, hostNamespace: string, isCold(): boolean,
  trace: NativeOutputTrace,
}) {
  if (!isCold()) throw new Error('Native maintenance requires an exclusive cold lifecycle')
  const owner = openNativeOriginalMaintenance(memoryRoot, hostNamespace)
  if (!owner) return
  try {
    const work = owner.operations()
    const outputs = owner.outputOperations()
    if (!work.length && !outputs.length) return
    const root = await realpath(sessionsRoot)
    for (const { operationId, plan } of work) {
      const operation = owner.operation(operationId, plan)
      const catalog = new Context()
      const mounted = await catalog.plugin(jsonl, { root })
      const cuts = new Set<string>()
      const copies = await (async () => {
        try {
          return await discoverNativeOriginalCopies(root, catalog.sessionPersistence, operation.messageIds, candidate => {
            const allowed = operation.authorize(candidate)
            if (allowed?.kind === 'cut') cuts.add(candidate.sessionId)
            return Boolean(allowed)
          })
        } finally { await mounted.dispose() }
      })()
      for (const sessionId of operation.pendingSessions()) if (![...copies.keys()].some(id => id === sessionId)) {
        throw new Error('Native publication is missing from its catalog')
      }
      await clearNativeProjections(storageRoot, [...copies.keys()].filter(session => !operation.publication(session)?.published))
      for (const [session, messages] of copies) {
        const saved = operation.publication(session)
        if (saved?.published) {
          if (cuts.has(session)) throw new Error('A published native erasure was replaced')
          continue
        }
        if (!saved && !cuts.has(session)) {
          operation.markCopied(session)
          continue
        }
        type Medium = NonNullable<typeof saved>['media'][number]
        const media = new Map<string, Medium>()
        await rewriteColdNativeSession({ root, sessionId: session, operationId, compression: 'zstd',
          retired: isCold,
          journal: {
            pending: () => saved?.intent,
            prepare: intent => operation.prepare(session, { intent, media: [...media.values()] }),
            finish: intent => operation.finish(session, intent),
          },
          transform(events) {
            const replacements = new Map<string, (digest: string) => Medium>()
            const result = projectNativeOriginals(events, candidate => {
              const proof = operation.authorize({ ...candidate, sessionId: session })
              if (proof?.kind !== 'cut') return
              replacements.set(candidate.messageId, proof.replaced)
              return proof.wireCuts
            })
            for (const [id, digest] of result.digests) media.set(id, replacements.get(id)!(digest))
            if ([...messages].some(id => !media.has(id))) throw new Error('Native original catalog changed before its rewrite')
            return result.events
          },
        })
      }
      operation.complete()
    }
    for (const operation of outputs) await eraseNativeOutputs({ root, storageRoot, operation, isCold, trace })
  } catch (error) {
    if (owner.carriesUnsettledPublication()) throw new PendingNativePublication('Native session publication must recover before startup', { cause: error })
    throw error
  } finally { owner.close() }
}
