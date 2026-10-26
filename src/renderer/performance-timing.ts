/** Opt-in timings only: localStorage.setItem('viva:session-timing', '1'). No message or configuration content. */
export function recordRendererTiming(stage: string, durationMs: number) {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('viva:session-timing') === '1') {
      console.info('[session-timing:renderer]', { stage, durationMs: Math.round(durationMs * 100) / 100 })
    }
  } catch { /* Storage can be unavailable; diagnostics must never interrupt the interaction. */ }
}
