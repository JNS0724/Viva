/**
 * viva-permission: what the assistant may do without asking, the level the user picked in the window
 * (完全 / 自动 / 工作区修改 / 仅可查看), applied to every session dsh opens or takes up again, so a conversation
 * goes on at the level picked now, whatever it had before. The level is the profile's config: the app writes
 * it and restarts dsh when the user picks another (src/shell/main.ts). 自动 is dsh's experimental Auto review
 * (@deepseek-ai/dsh-experimental-auto-review, loaded with this plugin): the model checks each step and asks
 * the user only about the ones it will not allow.
 *
 * A session the app marks as unattended (a schedule's run, over the IPC channel: `{ type: 'read_only_session', id,
 * sessionId }`, answered `read_only_session_ok`) may only look things up, whatever the level (access.ts
 * unattendedDecision): nobody is there to be asked.
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
// What dsh adds to the context: ctx.permissionPresets.
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-tools'
import { accessDecision, unattendedDecision } from './access.ts'

export const name = 'viva-permission'
export const inject = ['permissionPresets', 'sessions', 'tools', 'fs']
/** dsh's preset names (dsh-base's permission presets, and Auto). */
export const LEVELS = Object.freeze(['danger-full-access', 'auto', 'workspace-write', 'read-only'])
export const Config = z.object({ preset: z.union(LEVELS).default('workspace-write') })

type Port = { send?: (message: object) => unknown, on: Function, off: Function, channel?: { unref?: () => void } | null }

/** Sessions marked unattended, by id; the app marks one before its first prompt and waits for the answer. */
function serveUnattended(port: Port, unattended: Set<string>) {
  const onMessage = (message: any) => {
    if (message?.type !== 'read_only_session' || typeof message.sessionId !== 'string' || !message.sessionId) return
    unattended.add(message.sessionId)
    port.send?.({ type: 'read_only_session_ok', id: String(message.id ?? '') })
  }
  port.on('message', onMessage)
  return () => port.off('message', onMessage)
}

/** @param port the channel to the app (tests pass their own) */
export function apply(ctx: Context, config: { preset: string }, port: Port = process) {
  const pin = (session: Parameters<Context['permissionPresets']['current']>[0]) => {
    try {
      if (ctx.permissionPresets.current(session) !== config.preset) ctx.permissionPresets.set(session, config.preset)
    } catch (err: any) {
      ctx.logger?.warn?.(`viva-permission: could not set ${config.preset}: ${err.message}`)
    }
  }
  ctx.on('session/created', pin)
  for (const session of ctx.sessions.list()) pin(session)
  const unattended = new Set<string>()
  if (typeof port.send === 'function') {
    // The channel must not keep dsh running once its input closes.
    port.channel?.unref?.()
    ctx.effect(() => serveUnattended(port, unattended), 'unattended sessions')
  }
  ctx.on('tools/pre-execute', async (exec, next) => {
    const request = {
      name: exec.name, args: exec.arguments, cwd: exec.agent?.session.header.cwd,
      canonicalize: async (file: string, cwd: string) => ctx.fs.processPath(await ctx.fs.resolve(file, { cwd, signal: exec.signal })),
    }
    const decision = unattended.has(String(exec.agent?.session.id ?? ''))
      ? await unattendedDecision(request)
      : await accessDecision({ ...request, preset: config.preset })
    return decision ?? next()
  })
}
