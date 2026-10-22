/**
 * viva-permission: what the assistant may do without asking, the level the user picked in the window
 * (完全 / 自动 / 工作区修改 / 仅可查看), applied to every session dsh opens or takes up again, so a conversation
 * goes on at the level picked now, whatever it had before. The level is the profile's config: the app writes
 * it and restarts dsh when the user picks another (src/main/main.js). 自动 is dsh's experimental Auto review
 * (@deepseek-ai/dsh-experimental-auto-review, loaded with this plugin): the model checks each step and asks
 * the user only about the ones it will not allow.
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
// What dsh adds to the context: ctx.permissionPresets.
import type {} from '@deepseek-ai/dsh-permission-presets'

export const name = 'viva-permission'
export const inject = ['permissionPresets', 'sessions']
/** dsh's preset names (dsh-base's permission presets, and Auto). */
export const LEVELS = Object.freeze(['danger-full-access', 'auto', 'workspace-write', 'read-only'])
export const Config = z.object({ preset: z.union(LEVELS).default('workspace-write') })

export function apply(ctx: Context, config: { preset: string }) {
  const pin = (session: Parameters<Context['permissionPresets']['current']>[0]) => {
    try {
      if (ctx.permissionPresets.current(session) !== config.preset) ctx.permissionPresets.set(session, config.preset)
    } catch (err: any) {
      ctx.logger?.warn?.(`viva-permission: could not set ${config.preset}: ${err.message}`)
    }
  }
  ctx.on('session/created', pin)
  for (const session of ctx.sessions.list()) pin(session)
}
