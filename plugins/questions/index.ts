/**
 * viva-questions: when the model asks the user something (dsh's ask_user_question tool, enabled in the app's
 * profile next to this plugin), the question goes to the app's window and the tool waits for the answer.
 * dsh's ACP front end has no way to ask, so this plugin answers dsh's `user-questions/request` itself and
 * hands the question over the IPC channel the app opened when it started dsh (lib/channel.js).
 * Loaded by the app's dsh profile (src/main/dsh-profile.js).
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
// What dsh adds to the context: the user-questions/request event.
import type {} from '@deepseek-ai/dsh-user-questions'
import { createQuestionChannel } from './lib/channel.ts'

export const name = 'viva-questions'
export const Config = z.object({})

const log = (message: string) => process.stderr.write(`[${name}] ${message}\n`)

/** @param port the channel to the app (tests pass their own) */
export function apply(ctx: Context, _config: object, port: NodeJS.Process = process) {
  if (typeof port.send !== 'function') {
    log('dsh was not started by the app: questions are left to other answerers')
    return
  }
  const channel = createQuestionChannel({ send: port.send.bind(port), on: port.on.bind(port), off: port.off.bind(port) }, log)
  // The channel must not keep dsh running once its input closes.
  port.channel?.unref?.()
  ctx.effect(() => () => channel.close(), 'questions channel')
  ctx.on('user-questions/request', (request) => channel.ask(request))
}
