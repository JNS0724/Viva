/** Poll both local state and remote owner queries; a pending promise is not a successful condition. */
export async function eventually<T>(read: () => T | Promise<T>, { timeoutMs = 15_000, intervalMs = 100 } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value || Date.now() > deadline) return value
    await new Promise<void>(resolve => setTimeout(resolve, intervalMs))
  }
}
