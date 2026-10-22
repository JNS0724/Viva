/**
 * viva-policy: the app's tool rules, applied inside dsh before any tool runs (lib/rules.js). A refused
 * call reaches the model as a tool error with the reason, and never reaches the user's approval card.
 * Loaded by the app's dsh profile (src/main/dsh-profile.js).
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
// What dsh adds to the context: ctx.tools and its tools/pre-execute hook.
import type {} from '@deepseek-ai/dsh-tools'
import { decide } from './lib/rules.ts'

export const name = 'viva-policy'
export const inject = ['tools']
export const Config = z.object({})

export function apply(ctx: Context) {
  ctx.on('tools/pre-execute', async (exec, next) => decide(exec) ?? next(), { prepend: true })
}
