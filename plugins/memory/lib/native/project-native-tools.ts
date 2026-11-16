import type { SessionEvent } from '@deepseek-ai/dsh-session'

export type NativeToolResultEvent = SessionEvent<'tool/result'>

/** Keep the pairing and outcome while withdrawing the data returned by the tool. */
export function projectNativeToolResult(event: NativeToolResultEvent): NativeToolResultEvent | undefined {
  const { message, meta: _private, error, ...data } = event.data
  // Result images can have an image/offload projection into a particular block.
  if (message.content.some(block => block.type !== 'text')) return
  return { ...event, data: { ...data, message: { ...message, content: [] },
    ...(error ? { error: { name: error.name, code: error.code } } : {}) } }
}

/** The stock pruner links each replacement to the preceding result, including
 * replacements added in a fork after the original result was inherited. */
export function nativeToolResultCopies(events: readonly SessionEvent[], result: NativeToolResultEvent) {
  const results = new Map<number, NativeToolResultEvent>([[result.seq, result]])
  for (let seq = result.seq + 1; seq < events.length; seq++) {
    const event = events[seq]
    if (event?.type !== 'tool/result' || !event.sourceEventSeqs?.some(source => results.has(source))) continue
    const replace = event.surfaceOp
    if (typeof replace !== 'object' || replace.op !== 'replace' || replace.startSeq !== replace.endSeq
      || event.sourceEventSeqs.length !== 1 || event.sourceEventSeqs[0] !== replace.startSeq
      || event.data.message.toolCallId !== result.data.message.toolCallId || event.data.message.id !== result.data.message.id
      || event.data.turn !== result.data.turn || event.data.step !== result.data.step) return
    results.set(event.seq, event)
  }
  return results
}
