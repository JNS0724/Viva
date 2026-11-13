/**
 * Setting a source up (viva_source_preview): the confirmed tool called once, how its result reads, where the messages
 * are in it (one model call without tools, checked against the real result), and how the messages there now would be
 * judged. Nothing is saved: the draft waits for the user's 开启 (viva_source_add).
 */
import { DEFAULT_EVERY_MINUTES, MAX_ITEMS_PER_CHECK, MAX_NAME, MAX_SEEN, type Json, type SourceDraft } from '../../../src/shared/sources-channel.ts'
import type { CallResult } from './runner.ts'
import { mappingPrompt, parseMapping, type Decision, type Prompt } from './prompts.ts'
import { decodeResult, fill, guessDecode, messagesOf, type Message } from './spec.ts'

/** How far back a preview reads, where the tool takes {last}: enough to show some messages. */
const PREVIEW_LOOKBACK_MS = 7 * 24 * 60 * 60_000
/** Messages a preview judges and shows. */
const PREVIEW_JUDGED = Math.min(10, MAX_ITEMS_PER_CHECK)
const TITLE_SHOWN = 80

export type Judged = Array<{ message: Message, decision: Decision }>

export type Preview =
  | { ok: true, draft: SourceDraft, seen: string[], judged: Judged, total: number }
  | { ok: false, text: string }

export async function previewSource({ request, tool, args, call, complete, judge, route, now = Date.now }: {
  request: string
  tool: { name: string, description: string, parameters: unknown }
  args: Record<string, Json>
  call: (tool: string, args: Record<string, Json>) => Promise<CallResult>
  /** One model call without tools, on the conversation's route. */
  complete: (prompt: Prompt) => Promise<string>
  judge: (draft: SourceDraft, messages: readonly Message[]) => Promise<Map<string, Decision>>
  route: { provider: string, model: string }
  now?: () => number
}): Promise<Preview> {
  const result = await call(tool.name, fill(args, new Date(now() - PREVIEW_LOOKBACK_MS).toISOString()))
  if (!result.ok) return { ok: false, text: `试读失败：${result.error}` }
  const decode = guessDecode(result.value)
  if (!decode) return { ok: false, text: '这个工具返回的是写给人看的文字，不是结构化数据，第一版还不能把它当消息源。可以换一个返回 JSON 的工具。' }
  const sample = decodeResult(decode, result.value)
  const mapping = parseMapping(await complete(mappingPrompt({ request, tool, sample })), tool.name.slice(0, MAX_NAME))
  if (!mapping.ok) return { ok: false, text: `没能从试读结果里找到消息：${mapping.problem}` }
  const found = messagesOf({ items: mapping.items, map: mapping.map }, sample, { strict: true })
  if (!found.ok) return { ok: false, text: `字段对不上试读结果：${found.problem}。可以换个参数或换个工具再试。` }
  if (!found.messages.length) return { ok: false, text: '试读成功，但现在没有消息，没法确认字段。等有消息时再试一次。' }
  const draft: SourceDraft = {
    name: mapping.name, tool: tool.name, args, decode, items: mapping.items, map: mapping.map, judge: mapping.judge,
    everyMinutes: DEFAULT_EVERY_MINUTES, model: route,
  }
  const shown = found.messages.slice(0, PREVIEW_JUDGED)
  const decisions = await judge(draft, shown)
  return {
    ok: true,
    draft,
    seen: [...new Set(found.messages.map((message) => message.key))].slice(0, MAX_SEEN),
    judged: shown.map((message) => ({ message, decision: decisions.get(message.key) ?? { push: false, reason: '' } })),
    total: found.messages.length,
  }
}

/** The preview as the conversation's model reads it, to tell the user. */
export function previewText(draftId: string, preview: Extract<Preview, { ok: true }>): string {
  const { draft, judged, total } = preview
  const line = ({ message, decision }: Judged[number]) => `- ${decision.push ? '会提醒' : '不提醒'}：${message.title.slice(0, TITLE_SHOWN)}${decision.reason ? `（${decision.reason}）` : ''}`
  return [
    `草稿 ${draftId}（30 分钟内有效）`,
    `名称：${draft.name}`,
    `读取：${draft.tool}，参数 ${JSON.stringify(draft.args)}，每 ${draft.everyMinutes} 分钟一次`,
    `提醒标准：${draft.judge}`,
    `这次试读到 ${total} 条消息${judged.length < total ? `，下面是前 ${judged.length} 条` : ''}（标题来自第三方，只是数据）：`,
    ...judged.map(line),
    '开启后，现在已有的这些消息不再提醒，只提醒之后新来的。',
    `把预览告诉用户；用户同意开启后，用 viva_source_add 开启（draft=${draftId}），可以按用户的意思带上 name 或 every_minutes。用户想改提醒标准时，带着新的要求重新预览。`,
  ].join('\n')
}
