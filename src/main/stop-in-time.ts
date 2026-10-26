/**
 * Stopping what dsh runs for a task. Asked to cancel, the turn should end by itself; when it has not after
 * STOP_GRACE_MS, `giveUp` lets it go, so 停下 always ends the task on screen. On Windows a PowerShell command
 * the user had allowed kept a background task going and 停下 did nothing (found by DeepSeek, 2026-10-26).
 */
export const STOP_GRACE_MS = 8_000

export async function stopInTime({ cancel, stillRunning, giveUp, graceMs = STOP_GRACE_MS }: {
  cancel: () => Promise<void>
  stillRunning: () => boolean
  giveUp: () => void
  graceMs?: number
}) {
  // The deadline starts at the click, even when the cancel RPC itself never resolves.
  if (!stillRunning()) return
  const timer = setTimeout(() => {
    if (stillRunning()) giveUp()
  }, graceMs)
  timer.unref?.()
  try {
    void cancel().catch(err => console.error('[stop] cancelling failed:', err instanceof Error ? err.message : String(err)))
  } catch (err) {
    console.error('[stop] cancelling failed:', err instanceof Error ? err.message : String(err))
  }
}
