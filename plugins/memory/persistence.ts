import path from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { acquireSessionRootLease } from './lib/native/session-root-lease.ts'
import { registerStandaloneOwner } from './lib/standalone-owner.ts'

export const name = 'viva-memory-session-persistence'
export type Config = Omit<jsonl.Config, 'compression'> & { compression?: 'zstd', memoryRoot: string, storageRoot: string }
export const Config: z<Config> = z.object({
  root: z.string().required(),
  compression: z.const('zstd').default('zstd'),
  listConcurrency: jsonl.Config.dict!.listConcurrency,
  memoryRoot: z.string().required(),
  storageRoot: z.string().required(),
})

/** Publish the stock persistence service only after exclusive cold maintenance.
 * All processes sharing this standalone profile use the same provider wrapper. */
export async function apply(ctx: Context, { memoryRoot, storageRoot, ...config }: Config) {
  if (![config.root, memoryRoot, storageRoot].every(path.isAbsolute)) throw new Error('Memory persistence roots must be absolute')
  let owner: ReturnType<typeof registerStandaloneOwner> | undefined
  let service: Fiber | undefined, closing: Promise<void> | undefined
  const lease = acquireSessionRootLease({ memoryRoot, sessionsRoot: config.root, storageRoot }, () => {
    void close().catch(error => console.error('[memory] native persistence shutdown failed', error))
  })
  const close = () => {
    closing ??= Promise.resolve().then(async () => {
      try {
        await service?.dispose()
      } finally {
        try { await owner?.close() } finally { await lease.close() }
      }
    })
    return closing
  }
  ctx.effect(() => close, 'memory persistence lifecycle')
  try {
    await lease.ready
    if (closing) return
    owner = registerStandaloneOwner(memoryRoot)
    await owner.start()
    if (closing) return
    service = ctx.plugin(jsonl, config)
    await service.await()
  } catch (error) {
    await close()
    throw error
  }
}
