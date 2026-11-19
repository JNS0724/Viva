import type { StreamChunk } from '@deepseek-ai/dsh-llm'

// While the owner verifies output, accept a bounded burst from the provider. Only
// adjacent deltas of the same block may share a delivery and its authorization.
const MAX_PENDING_CHUNKS = 32
export async function* verifiedModelOutput(
  read: () => Promise<IteratorResult<StreamChunk>>,
  verify: () => Promise<boolean>,
) {
  const queue: StreamChunk[] = []
  let filling: Promise<void> | undefined
  let wake: (() => void) | undefined
  let done = false, stopped = false
  let failure: { error: unknown } | undefined

  function fill() {
    if (filling || done || stopped) return
    filling = (async () => {
      try {
        while (!stopped && queue.length < MAX_PENDING_CHUNKS) {
          const item = await read()
          if (item.done) { done = true; break }
          queue.push(item.value)
          wake?.()
        }
      } catch (error) { failure = { error }; done = true }
      finally { wake?.() }
    })().finally(() => { filling = undefined })
  }

  try {
    for (;;) {
      if (!queue.length && !done) {
        const available = new Promise<void>(resolve => { wake = resolve })
        fill()
        await available
        wake = undefined
      }
      const first = queue.shift()
      if (!first) {
        if (failure) throw failure.error
        // A recalled response must not settle successfully after its final visible chunk.
        if (!await verify()) throw new Error('Memory context changed before model output was accepted')
        return
      }
      let chunk = first
      if (first.type === 'text-delta' || first.type === 'reasoning-delta') {
        let text = first.text
        while (queue[0]?.type === first.type) {
          const next = queue[0]
          if (next.index !== first.index) break
          text += next.text
          queue.shift()
        }
        if (text !== first.text) chunk = { ...first, text }
      }
      fill()
      if (!await verify()) throw new Error('Memory context changed before model output was accepted')
      yield chunk
    }
  } finally { stopped = true }
}
