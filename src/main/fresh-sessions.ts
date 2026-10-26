/** One untouched session may initialize while the user reads. It is consumed once, never shared by topics. */
export function createFreshSessions<T>({ open, close }: { open: (cwd: string, speculative: boolean) => Promise<T>, close: (session: T) => Promise<unknown> }) {
  let spare: { key: string, promise: Promise<T> } | null = null
  let disposed = false
  const discard = (entry: NonNullable<typeof spare>) => { void entry.promise.then(close).catch(() => {}) }
  function clear() { if (spare) discard(spare); spare = null }
  function prepare(key: string, cwd: string) {
    if (disposed || spare?.key === key) return
    clear()
    const entry = { key, promise: open(cwd, true) }
    spare = entry
    void entry.promise.catch(() => { if (spare === entry) spare = null })
  }
  async function take(key: string, cwd: string) {
    if (spare?.key === key) {
      const entry = spare; spare = null
      try { return await entry.promise } catch { /* A failed speculative open cannot make a requested topic fail. */ }
    } else clear()
    return open(cwd, false)
  }
  return { prepare, take, clear, dispose() { disposed = true; clear() } }
}
