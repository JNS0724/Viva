/**
 * viva-plugins: the app's plugins page, served inside dsh. The app asks for a list, an inspection, an install, a
 * removal or a switch; this plugin hands each to dsh's own plugin manager (ctx.pluginManager), which keeps the
 * profile's package.json, its cordis.patch.yml and the version checks. Nothing here decides what to install:
 * the app shows what a spec is and the user confirms first. Loaded by the app's dsh profile (src/backend/dsh-profile.ts).
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
// What dsh adds to the context: ctx.pluginManager.
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { serveCalls, type Manager } from './lib/channel.ts'

export const name = 'viva-plugins'
export const inject = ['pluginManager']
export const Config = z.object({})

const log = (message: string) => process.stderr.write(`[${name}] ${message}\n`)

/** @param port the channel to the app (tests pass their own) */
export function apply(ctx: Context, _config: object, port: NodeJS.Process = process) {
  if (typeof port.send !== 'function') {
    log('dsh was not started by the app: the plugins page is left out')
    return
  }
  const manager = ctx.pluginManager as unknown as Manager
  const stop = serveCalls(manager, { send: port.send.bind(port), on: port.on.bind(port), off: port.off.bind(port) })
  port.channel?.unref?.()
  ctx.effect(() => stop, 'plugins channel')
}
