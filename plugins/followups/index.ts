/**
 * viva-followups: the follow-ups' side inside dsh. Loaded by the app's dsh profile (src/main/dsh-profile.js).
 *
 * - In the conversation, the model may only propose a follow-up (viva_followup_propose) when the user asks to be
 *   reminded or helped at a time; the app shows it on a card and makes it only on the user's yes. The model
 *   cannot make, change or remove a follow-up, nor write memory, from here.
 * - For background preparation the app asks for one model call (lib/channel.ts `prepare`): no tools at all, so
 *   whatever the materials say (a mail that reads "忽略之前的指示"), nothing can be run, written or sent; only a
 *   draft comes back. It uses the route the app names, the model the user picked.
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { prepareRequest, type PrepareRequest, type Proposal } from './lib/channel.ts'

export const name = 'viva-followups'
export const inject = ['tools', 'llm']
export const Config = z.object({})

const log = (message: string) => process.stderr.write(`[${name}] ${message}\n`)
type MessageSource = Parameters<typeof createUserMessage>[0]['source']
/** dsh's types list its own message sources and call purposes only; it passes ours through. */
const ownSource = { kind: name } as unknown as MessageSource
const PREPARE_PURPOSE = 'followup-prepare' as unknown as NonNullable<Parameters<Context['llm']['stream']>[0]['purpose']>
/** One preparation never runs longer than this; the app's batch has its own limit too. */
const PREPARE_TIMEOUT_MS = 3 * 60 * 1000
const MAX_FILES = 5

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
  // A draft cut at the token limit is still worth showing; anything else (an error, a tool call) is not.
  if (assembler.finish?.kind !== 'stop' && assembler.finish?.kind !== 'max-tokens') throw new Error(`模型停在了 ${assembler.finish?.kind ?? '中途'}`)
  return assembler.blocks().filter((block) => block.type === 'text').map((block) => block.text).join('').trim()
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

const proposalOf = (args: Record<string, any>): Proposal => ({
  title: String(args.title ?? ''),
  ask: String(args.ask ?? ''),
  ...(args.remind_at ? { remindAt: String(args.remind_at) } : {}),
  ...(args.prepare_by ? { prepareBy: String(args.prepare_by) } : {}),
  ...(Array.isArray(args.files) ? { files: args.files.slice(0, MAX_FILES).map(String) } : {}),
  ...(args.watch_file ? { watchFile: String(args.watch_file) } : {}),
})

function registerPropose(ctx: Context, port: Port) {
  let seq = 0
  ctx.tools.register(defineTool({
    name: 'viva_followup_propose',
    description: '用户明确说「提醒我」「到时候帮我做」并且给了时间，或说「这个文件变了就帮我……」时，提出一条跟进建议。用户会在窗口里的卡片上看到它，点「跟进」才会生效；'
      + '你不能自己建立、修改或删除跟进，也不要在回答里承诺你一定会提醒。闲聊里随口提到的事、没有时间的事，不要提。'
      + '时间一律写成带时区的具体日期时间（ISO 8601，例如 2026-10-30T17:00:00+08:00），「周五下班前」这类说法要换算成具体时间，用户会在卡片上确认。',
    parameters: {
      title: { type: 'string', required: true, description: '一个短标题，例如「周报」' },
      ask: { type: 'string', required: true, description: '到时候要做什么，用用户的话写清楚，例如「按上周的模板起草周报：结论、推进中的事、下周计划」' },
      remind_at: { type: 'string', description: '什么时候提醒用户（ISO 8601）' },
      prepare_by: { type: 'string', description: '要在什么时候之前在后台准备好草稿（ISO 8601）；只提醒、不用准备就不写' },
      files: { type: 'array', items: { type: 'string' }, description: '准备时要读的文件（用户点名的），最多 5 个；没有就不写' },
      watch_file: { type: 'string', description: '用户说「这个文件变了就帮我……」时，要盯着的那个文件；这时可以不写时间' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => {
      port.send({ type: 'followup_propose', id: `p${++seq}-${Date.now().toString(36)}`, sessionId: String(exec?.agent?.session?.id ?? ''), proposal: proposalOf(args ?? {}) })
      return { text: '已经在窗口里给用户看了跟进建议卡片。由用户决定要不要跟进；不要说你已经安排好了。' }
    },
  }))
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
  registerPropose(ctx, channel)
}
