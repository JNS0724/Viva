import { MEMORY_EMBEDDING_BATCH } from './memory-embedder.ts'
import type { MemoryEmbedder } from './memory-embedder.ts'
import type { MemorySemanticIndex, MemorySemanticReference } from './memory-semantic.ts'

type Passage = MemorySemanticReference & { text: string | null }
const IDLE_DELAY_MS = 200
const RETRY_DELAY_MS = 30_000

/** Fill the derived index through bounded local batches, using canonical authorization supplied by the runtime. */
export function createMemorySemanticMaintenance({ index, embedder, page, current, busy, delayMs = IDLE_DELAY_MS }: {
  index: () => MemorySemanticIndex | null,
  embedder: Pick<MemoryEmbedder, 'fingerprint' | 'embedBatch'>,
  page: (afterId: number, limit: number) => { entries: readonly Passage[], nextId: number | null },
  current: (ref: MemorySemanticReference) => boolean,
  busy: () => boolean,
  delayMs?: number,
}) {
  const { fingerprint } = embedder
  let afterId = 0
  let rescan = false
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let active: AbortController | undefined

  function arm(delay: number) {
    if (closed || timer !== undefined || active) return
    timer = setTimeout(() => {
      timer = undefined
      void run()
    }, delay)
    timer.unref()
  }

  async function run() {
    if (closed) return
    if (busy()) { arm(delayMs); return }
    const target = index()
    if (!target) return
    const controller = new AbortController()
    active = controller
    let nextDelay: number | undefined
    try {
      target.configure(fingerprint)
      const version = target.version(fingerprint)
      if (version === null) return
      const { entries, nextId } = page(afterId, MEMORY_EMBEDDING_BATCH)
      const texts = entries.flatMap(entry => entry.text === null ? [] : [{ kind: 'passage' as const, text: entry.text }])
      const vectors = texts.length ? await embedder.embedBatch(texts, controller.signal) : []
      if (closed || controller.signal.aborted || target !== index() || target.version(fingerprint) !== version) return
      if (!vectors || vectors.length !== texts.length) { nextDelay = RETRY_DELAY_MS; return }
      let position = 0
      const admitted = entries.flatMap(entry => {
        const vector = entry.text === null ? null : vectors[position++]
        return current(entry) ? [{ id: entry.id, revision: entry.revision, vector }] : []
      })
      if (target.put(fingerprint, admitted, version) !== admitted.length) { nextDelay = RETRY_DELAY_MS; return }
      if (nextId !== null) {
        afterId = nextId
        nextDelay = delayMs
      } else {
        afterId = 0
        if (rescan) { rescan = false; nextDelay = delayMs }
      }
    } catch {
      nextDelay = RETRY_DELAY_MS
    } finally {
      if (active === controller) {
        active = undefined
        if (nextDelay !== undefined) arm(nextDelay)
      }
    }
  }

  function pause() {
    clearTimeout(timer)
    timer = undefined
    const previous = active
    active = undefined
    previous?.abort()
  }

  return {
    schedule(changed = false) {
      if (changed && (afterId !== 0 || active)) rescan = true
      arm(delayMs)
    },
    pause,
    reset() {
      pause()
      afterId = 0
      rescan = false
    },
    close() {
      closed = true
      pause()
    },
  }
}
