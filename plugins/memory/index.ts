/** Independently runnable DSH adapter; a trusted host channel is optional. */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryPluginConfig } from './lib/config.ts'
import { applyMemoryAdapter } from './lib/adapter.ts'

export const name = 'viva-memory'
export const inject = ['agents', 'sessions', 'tools', 'llm', 'userQuestions']
export const Config = z.object({
  host: z.boolean().default(false),
  dataRoot: z.string(),
  modelRoot: z.string(),
  runtimeRoot: z.string(),
  dailyNotes: z.boolean().default(true),
  fileMode: z.boolean().default(false),
})
export function apply(ctx: Context, config: MemoryPluginConfig = {}) {
  return applyMemoryAdapter(ctx, config)
}
