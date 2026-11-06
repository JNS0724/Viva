/**
 * viva-followups: the follow-ups' side inside dsh. Loaded by the app's dsh profile (src/backend/dsh-profile.ts).
 *
 * - For background preparation the app asks for one model call (lib/channel.ts `prepare`): no tools at all, so
 *   whatever the materials say (a mail that reads "忽略之前的指示"), nothing can be run, written or sent; only a
 *   draft comes back. It uses the route the app names, the model the user picked.
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { prepareRequest, type PrepareRequest } from './lib/channel.ts'
import { preparationText } from './lib/result.ts'

export const name = 'viva-followups'
export const inject = ['llm']
export const Config = z.object({})

const log = (message: string) => process.stderr.write(`[${name}] ${message}\n`)
type MessageSource = Parameters<typeof createUserMessage>[0]['source']
/** dsh's types list its own message sources and call purposes only; it passes ours through. */
const ownSource = { kind: name } as unknown as MessageSource
const PREPARE_PURPOSE = 'followup-prepare' as unknown as NonNullable<Parameters<Context['llm']['stream']>[0]['purpose']>
/** One preparation never runs longer than this; the app's batch has its own limit too. */
const PREPARE_TIMEOUT_MS = 3 * 60 * 1000

type Port = { send: (message: object) => unknown, on: Function, off: Function }

/** One text-only call; no `tools` are passed, so the model can only write. */
async function complete(ctx: Context, request: PrepareRequest, signal: AbortSignal): Promise<string> {
  const assembler = new BlockAssembler()
  const stream = ctx.llm.stream({
    provider: request.provider,
    model: request.model,
    system: request.system,
    messages: [createUserMessage({ content: [{ type: 'text', text: request.input }], source: ownSource })],
    maxTokens: request.maxTokens,
    purpose: PREPARE_PURPOSE,
    signal,
  })
  for await (const chunk of stream) assembler.push(chunk)
  return preparationText(assembler, request.requireComplete)
}

/** Answers the app's prepare requests, one call each, stopped when the app says the user came back. */
function servePrepare(ctx: Context, port: Port) {
  const running = new Map<string, AbortController>()
  const onMessage = (message: any) => {
    if (message?.type === 'prepare_cancel') return running.get(String(message.id))?.abort(new Error('你回来了，先停下'))
    const request = prepareRequest(message)
    if (!request) {
      if (message?.type === 'prepare') port.send({ type: 'prepare_result', id: String(message.id ?? ''), ok: false, text: '准备请求不完整' })
      return undefined
    }
    const controller = new AbortController()
    running.set(request.id, controller)
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
    complete(ctx, request, signal)
      .then((text) => port.send({ type: 'prepare_result', id: request.id, ok: Boolean(text), text: text || '模型没有写出内容' }))
      .catch((err) => port.send({ type: 'prepare_result', id: request.id, ok: false, text: err instanceof Error ? err.message : String(err) }))
      .finally(() => running.delete(request.id))
    return undefined
  }
  port.on('message', onMessage)
  return () => {
    port.off('message', onMessage)
    running.forEach((controller) => controller.abort(new Error('dsh 正在退出')))
  }
}

/** @param port the channel to the app (tests pass their own) */
export function apply(ctx: Context, _config: object, port: NodeJS.Process = process) {
  if (typeof port.send !== 'function') {
    log('dsh was not started by the app: follow-ups are left out')
    return
  }
  const channel: Port = { send: port.send.bind(port), on: port.on.bind(port), off: port.off.bind(port) }
  // The channel must not keep dsh running once its input closes.
  port.channel?.unref?.()
  ctx.effect(() => servePrepare(ctx, channel), 'followup prepare')
}
