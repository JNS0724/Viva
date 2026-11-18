/**
 * What a turn did, as the steps the app's 过程 tab shows: thoughts, and tool calls with their outcome.
 * Built from dsh session events (`{ type, seq, time, data }`, the same shape dsh logs), so the plugin can
 * record them live and the app can still read sessions from before the plugin existed. Pure.
 */
const MAX_TEXT_CHARS = 4000

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

function parsedArguments(raw: unknown): Record<string, unknown> {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

const reasoningOf = (message: { content?: Array<{ type: string, text?: string }> } | undefined) => (message?.content ?? [])
  .filter((part) => part.type === 'reasoning').map((part) => part.text ?? '').join('')

type ThoughtStep = { seq: number, at: number, kind: 'thought', text: string }
type ToolResult = { content?: unknown, error?: unknown, meta?: unknown }
type ToolStep = { seq: number, at: number, kind: 'tool', callId: string, name: string, args: object, status: string, result?: ToolResult }
export type Step = ThoughtStep | ToolStep

/** @param events oldest first */
export function stepsFrom(events: Array<{ type: string, seq: number, time: number, data: any }>): Step[] {
  const steps: Step[] = []
  const toolAt = new Map<unknown, number>()
  for (const { type, seq, time, data } of events) {
    if (!data) continue
    if (type === 'assistant/message') {
      const text = reasoningOf(data.message)
      if (text) steps.push({ seq, at: time, kind: 'thought', text: clip(text, MAX_TEXT_CHARS) })
    } else if (type === 'tool/call' && data.callId) {
      toolAt.set(data.callId, steps.length)
      steps.push({ seq, at: time, kind: 'tool', callId: String(data.callId), name: String(data.name ?? ''), args: parsedArguments(data.arguments), status: 'in_progress' })
    } else if (type === 'tool/result') {
      const index = toolAt.get(data.message?.toolCallId)
      if (index !== undefined) steps[index] = { ...(steps[index] as ToolStep), status: data.message.isError ? 'failed' : 'completed',
        result: { content: data.message.content, error: data.error, meta: data.meta } }
    }
  }
  return steps
}
