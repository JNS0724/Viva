/**
 * What a turn did, as the steps the app's 过程 tab shows: thoughts, and tool calls with their outcome.
 * Built from dsh session events (`{ type, seq, time, data }`, the same shape dsh logs), so the plugin can
 * record them live and the app can still read sessions from before the plugin existed. Pure.
 */
const MAX_TEXT_CHARS = 4000
const MAX_ARGS_CHARS = 2000
/** When the arguments are too big to keep (file contents, long commands), only short values survive. */
const MAX_KEPT_VALUE_CHARS = 200

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

function parsedArguments(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/** The call's arguments, small enough to store: whole when short, else just their short scalar values. */
export function keptArguments(raw) {
  const args = parsedArguments(raw)
  if (JSON.stringify(args).length <= MAX_ARGS_CHARS) return args
  return Object.fromEntries(Object.entries(args).filter(([, value]) => (typeof value === 'string'
    ? value.length <= MAX_KEPT_VALUE_CHARS
    : typeof value === 'number' || typeof value === 'boolean')))
}

const reasoningOf = (message) => (message?.content ?? []).filter((part) => part.type === 'reasoning').map((part) => part.text).join('')

/**
 * @param {Array<{ type: string, seq: number, time: number, data: any }>} events oldest first
 * @returns {Array<{ seq: number, at: number, kind: 'thought', text: string }
 *   | { seq: number, at: number, kind: 'tool', callId: string, name: string, args: object, status: string }>}
 */
export function stepsFrom(events) {
  const steps = []
  const toolAt = new Map()
  for (const { type, seq, time, data } of events) {
    if (!data) continue
    if (type === 'assistant/message') {
      const text = reasoningOf(data.message)
      if (text) steps.push({ seq, at: time, kind: 'thought', text: clip(text, MAX_TEXT_CHARS) })
    } else if (type === 'tool/call' && data.callId) {
      toolAt.set(data.callId, steps.length)
      steps.push({ seq, at: time, kind: 'tool', callId: String(data.callId), name: String(data.name ?? ''), args: keptArguments(data.arguments), status: 'in_progress' })
    } else if (type === 'tool/result') {
      const index = toolAt.get(data.message?.toolCallId)
      if (index !== undefined) steps[index] = { ...steps[index], status: data.message.isError ? 'failed' : 'completed' }
    }
  }
  return steps
}
