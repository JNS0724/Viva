import path from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { lockMemoryRoot } from '../../src/memory/node/owner-lock.ts'
import { eraseColdNativeCopies } from './lib/native/maintenance.ts'

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
  const lifetime = lockMemoryRoot(path.join(config.root, '.viva-memory-host'))
  let service: Fiber | undefined, closing: Promise<void> | undefined
  const maintenance = eraseColdNativeCopies({
    memoryRoot, sessionsRoot: config.root, storageRoot, hostNamespace: undefined,
    isCold: () => !closing && !service,
    trace: { key: () => undefined, erase() { throw new Error('Standalone persistence does not own a Viva trace') } },
  })
  const close = () => {
    closing ??= Promise.resolve().then(async () => {
      try {
        await maintenance.catch(() => {})
        await service?.dispose()
      } finally { lifetime.close() }
    })
    return closing
  }
  ctx.effect(() => close, 'memory persistence lifecycle')
  try {
    await maintenance
    if (closing) return
    service = ctx.plugin(jsonl, config)
    await service.await()
  } catch (error) {
    await close()
    throw error
  }
}
