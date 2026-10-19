/**
 * viva-questions: when the model asks the user something (dsh's ask_user_question tool, enabled in the app's
 * profile next to this plugin), the question goes to the app's window and the tool waits for the answer.
 * dsh's ACP front end has no way to ask, so this plugin answers dsh's `user-questions/request` itself and
 * hands the question over the IPC channel the app opened when it started dsh (lib/channel.js).
 * Loaded by the app's dsh profile (src/main/dsh-profile.js).
 */
import z from '@deepseek-ai/schemastery'
import { createQuestionChannel } from './lib/channel.js'

export const name = 'viva-questions'
export const Config = z.object({})

const log = (message) => process.stderr.write(`[${name}] ${message}\n`)

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} _config
 * @param {NodeJS.Process} [port] the channel to the app (tests pass their own)
 */
export function apply(ctx, _config, port = process) {
  if (typeof port.send !== 'function') {
    log('dsh was not started by the app: questions are left to other answerers')
    return
  }
  const channel = createQuestionChannel(port, log)
  // The channel must not keep dsh running once its input closes.
  port.channel?.unref?.()
  ctx.effect(() => () => channel.close(), 'questions channel')
  ctx.on('user-questions/request', (request) => channel.ask(request))
}
