/** One untouched session may initialize while the user reads. Never share an agent between topics. */
export function createFreshSessions<T>({ open, close, ttlMs = 120_000 }: {
  open: (cwd: string, speculative: boolean) => Promise<T>, close: (session: T) => Promise<unknown>, ttlMs?: number,
}) {
  type Entry = { key: string, promise: Promise<T>, ready: boolean, abandoned: boolean, timer?: ReturnType<typeof setTimeout> }
  let spare: Entry | null = null
  let disposed = false
  // A failed parallel start often means a singleton MCP. Do not keep probing it on every topic.
  let failedKey: string | null = null
  const retiring = new Set<Promise<unknown>>()
  const failedRetirements = new Set<T>()
  async function release(session: T) {
    try { await close(session); failedRetirements.delete(session) }
    catch (error) { failedRetirements.add(session); throw error }
  }
  function clear() {
    const entry = spare
    spare = null
    if (!entry) return
    entry.abandoned = true
    clearTimeout(entry.timer)
    const cleanup = entry.promise.then(release, () => {})
    retiring.add(cleanup)
    void cleanup.finally(() => retiring.delete(cleanup)).catch(() => {})
  }
  async function drained() {
    await Promise.all([...retiring, ...[...failedRetirements].map(release)])
  }
  function prepare(key: string, cwd: string) {
    if (disposed || spare?.key === key || failedKey === key) return
    clear()
    const entry: Entry = { key, promise: null!, ready: false, abandoned: false }
    const begin = () => {
      if (disposed || entry.abandoned) throw Error('unused session preparation was discarded')
      return open(cwd, true)
    }
    entry.promise = retiring.size || failedRetirements.size ? drained().then(begin) : begin()
    spare = entry
    void entry.promise.then(() => {
      entry.ready = true
      if (spare !== entry) return
      entry.timer = setTimeout(() => { if (spare === entry) clear() }, ttlMs)
      entry.timer.unref?.()
    }, () => {
      if (!entry.abandoned) failedKey = key
      if (spare === entry) spare = null
    })
  }
  async function take(key: string, cwd: string, { beforeOpen, onUse }: {
    beforeOpen?: () => Promise<unknown>, onUse?: (source: 'ready' | 'pending' | 'cold' | 'fallback') => void,
  } = {}) {
    if (disposed) throw Error('session preparation is disposed')
    let source: 'cold' | 'fallback' = 'cold'
    if (spare?.key === key) {
      const entry = spare; spare = null
      clearTimeout(entry.timer)
      const ready = entry.ready
      const result = await entry.promise.then(value => ({ value }), () => null)
      if (result) {
        if (disposed) { await close(result.value); throw Error('session preparation is disposed') }
        onUse?.(ready ? 'ready' : 'pending')
        return result.value
      }
      source = 'fallback'
    } else clear()
    // Release stale spares and the old session's singleton resources before a cold start.
    await drained()
    await beforeOpen?.()
    if (disposed) throw Error('session preparation is disposed')
    onUse?.(source)
    const result = await open(cwd, false)
    if (disposed) { await close(result); throw Error('session preparation is disposed') }
    return result
  }
  return { prepare, take, clear, reset() { failedKey = null; clear() }, dispose() { disposed = true; clear() } }
}
