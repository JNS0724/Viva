import { realpath } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { openNativeOriginalMaintenance } from '../../../../src/memory/node/native-original-maintenance.ts'
import { discoverNativeOriginalCopies } from './discover-native-replicas.ts'
import { rewriteColdNativeSession } from './native-cold-rewrite.ts'
import { clearNativeProjections } from './projection-cache.ts'
import { projectNativeOriginals } from './project-native-originals.ts'
import { eraseNativeOutputs } from './erase-native-outputs.ts'
import { eraseNativeToolResults } from './erase-native-tool-results.ts'
import { eraseNativeDerivedMessages } from './erase-native-derived-messages.ts'
import { eraseNativeRecoveryMessages } from './erase-native-recovery-messages.ts'
import type { NativeOutputTrace } from './publish-native-event-copies.ts'
import { reconcileNativeReceipts } from './reconcile-native-receipts.ts'
import { auditNativeErasure } from './audit-native-erasure.ts'
import { eraseNativeSpill } from './local-spills.ts'
import { recoverNativePtcInputs } from './recover-ptc-inputs.ts'

export class PendingNativePublication extends Error {
  override name = 'PendingNativePublication'
}

/** Run inside the host's cold lifecycle gate with no live persistence readers. */
export async function eraseColdNativeCopies({ memoryRoot, sessionsRoot, storageRoot, hostNamespace, isCold, trace }: {
  memoryRoot: string, sessionsRoot: string, storageRoot: string, hostNamespace: string | undefined, isCold(): boolean,
  trace: NativeOutputTrace,
}) {
  if (!isCold()) throw new Error('Native maintenance requires an exclusive cold lifecycle')
  const owner = openNativeOriginalMaintenance(memoryRoot, hostNamespace)
  if (!owner) return
  try {
    if (!owner.hasPlans()) return
    const root = await realpath(sessionsRoot)
    await recoverNativePtcInputs(root, owner)
    await reconcileNativeReceipts(root, owner)
    const work = owner.operations()
    const outputs = owner.outputOperations(), tools = owner.toolResultOperations()
    const derived = owner.derivedMessageOperations(), recoveries = owner.recoveryMessageOperations()
    const pendingOriginals = owner.pendingOriginalOperations()
    const tasks = [
      ...work.map(item => ({ pending: pendingOriginals.has(item.operationId),
        run: () => eraseNativeOriginals({ root, storageRoot, owner, item, isCold }) })),
      ...tools.map(operation => ({ pending: operation.journal.pendingSessions().length > 0,
        run: () => eraseNativeToolResults({ root, storageRoot, operation, isCold, trace }) })),
      ...recoveries.map(operation => ({ pending: operation.journal.pendingSessions().length > 0,
        run: () => eraseNativeRecoveryMessages({ root, storageRoot, operation, isCold, trace }) })),
      ...derived.map(operation => ({ pending: operation.journal.pendingSessions().length > 0,
        run: () => eraseNativeDerivedMessages({ root, storageRoot, operation, isCold, trace }) })),
      ...outputs.map(operation => ({ pending: operation.journal.pendingSessions().length > 0,
        run: () => eraseNativeOutputs({ root, storageRoot, operation, isCold, trace }) })),
    ]
    // A prepared receipt authenticates whole-file hashes. Resume that write
    // before another kind of erasure can alter the same session artifact.
    tasks.sort((a, b) => Number(b.pending) - Number(a.pending))
    for (const task of tasks) await task.run()
    for (const operation of owner.spillOperations()) {
      for (const target of operation.targets()) if (await eraseNativeSpill(target, isCold)) operation.complete(target.id)
    }
    // A complete cold catalog can attest no endpoint only after any local
    // result spill has been proved erased. Revisit input-only dispatch copies.
    await reconcileNativeReceipts(root, owner, true)
    for (const operation of owner.toolResultOperations()) await eraseNativeToolResults({ root, storageRoot, operation, isCold, trace })
    await auditNativeErasure(root, owner)
  } catch (error) {
    if (owner.carriesUnsettledPublication()) throw new PendingNativePublication('Native session publication must recover before startup', { cause: error })
    throw error
  } finally { owner.close() }
}

type Maintenance = NonNullable<ReturnType<typeof openNativeOriginalMaintenance>>

async function eraseNativeOriginals({ root, storageRoot, owner, item: { operationId, plan }, isCold }: {
  root: string, storageRoot: string, owner: Maintenance, item: ReturnType<Maintenance['operations']>[number], isCold(): boolean,
}) {
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
