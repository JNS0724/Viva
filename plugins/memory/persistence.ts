import path from 'node:path'
import { safeDiagnosticReason } from '../../src/diagnostics/contracts.ts'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { registerStandaloneOwner } from './lib/standalone-owner.ts'

export const name = 'viva-memory-session-persistence'
export type Config = Omit<jsonl.Config, 'compression'> & { compression?: 'zstd', memoryRoot: string }
export const Config: z<Config> = z.object({
  root: z.string().required(),
  compression: z.const('zstd').default('zstd'),
  listConcurrency: jsonl.Config.dict!.listConcurrency,
  memoryRoot: z.string().required(),
})

export function apply(ctx: Context, { memoryRoot, ...config }: Config) {
  if (![config.root, memoryRoot].every(path.isAbsolute)) throw new Error('Memory persistence roots must be absolute')
  const owner = registerStandaloneOwner(memoryRoot)
  ctx.effect(() => () => owner.close(), 'memory owner')
  void owner.start().catch(error => ctx.logger.warn('Memory worker startup failed (%s)', safeDiagnosticReason(error)))
  return ctx.plugin(jsonl, config).await()
}
