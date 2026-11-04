/**
 * How a process that died on its own is started again, waiting longer each time, until it keeps dying: dsh in the
 * backend (compose.ts), and the backend in the shell (src/shell/backend-keeper.ts).
 */
export const RESTART_DELAYS_MS: readonly number[] = Object.freeze([1_000, 3_000, 10_000])
/** Crashes further apart than this are not "in a row". */
export const CRASH_WINDOW_MS = 120_000

/**
 * How long to wait before starting it again, or null to stop trying.
 * @param crashes when it died, including this time
 */
export function restartDelay(crashes: readonly number[], now: number): number | null {
  const recent = crashes.filter((at) => now - at < CRASH_WINDOW_MS).length
  return recent >= 1 && recent <= RESTART_DELAYS_MS.length ? RESTART_DELAYS_MS[recent - 1] : null
}
