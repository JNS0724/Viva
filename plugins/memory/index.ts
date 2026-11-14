/** DSH adapter for the Viva backend's memory runtime. */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { applyMemoryAdapter } from './lib/adapter.ts'

export const name = 'viva-memory'
export const inject = ['agents', 'tools', 'llm', 'userQuestions']
export const Config = z.object({ host: z.boolean() })

export function apply(ctx: Context) {
  applyMemoryAdapter(ctx)
}
