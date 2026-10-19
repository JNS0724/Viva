/**
 * viva-policy: the app's tool rules, applied inside dsh before any tool runs (lib/rules.js). A refused
 * call reaches the model as a tool error with the reason, and never reaches the user's approval card.
 * Loaded by the app's dsh profile (src/main/dsh-profile.js).
 */
import z from '@deepseek-ai/schemastery'
import { decide } from './lib/rules.js'

export const name = 'viva-policy'
export const inject = ['tools']
export const Config = z.object({})

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => decide(exec) ?? next(), { prepend: true })
}
