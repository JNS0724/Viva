/** Diagnostic timings contain stages/counts only: no prompts, directories, MCP configuration or credentials. */
export type SessionTiming = { operation: number, stage: string, ms: number, ok: boolean, detail?: string }
let nextOperation = 0
export function sessionTiming(report: (sample: SessionTiming) => void = sample => {
  if (process.env.VIVA_SESSION_TIMING === '1') console.info('[session-timing]', JSON.stringify(sample))
}) {
  const operation = ++nextOperation
  return async function measure<T>(stage: string, run: () => Promise<T>, detail?: string): Promise<T> {
    const start = performance.now()
    let ok = false
    try { const result = await run(); ok = true; return result }
    finally { report({ operation, stage, ms: Math.round((performance.now() - start) * 100) / 100, ok, ...(detail ? { detail } : {}) }) }
  }
}
