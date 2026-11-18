/** Retain the original relative target and separately report a small absolute latency allowance. */
export function diagnosticLatencyBudget(disabledMs: number, enabledMs: number) {
  const deltaMs = enabledMs - disabledMs
  const deltaPercent = deltaMs / disabledMs * 100
  const originalTarget = deltaPercent <= 5 && deltaMs <= 10
  const acceptableLatency = Number.isFinite(deltaPercent) && (originalTarget || deltaMs <= 2)
  return { deltaMs, deltaPercent, originalTarget, acceptableLatency }
}
export function healthyDiagnosticSample(value: unknown) {
  if (!value || typeof value !== 'object') return false
  return 'droppedCount' in value && value.droppedCount === 0 && 'untrackedCount' in value && value.untrackedCount === 0
    && 'queuedBytes' in value && value.queuedBytes === 0 && 'activeCount' in value && value.activeCount === 0
    && 'writtenBytes' in value && typeof value.writtenBytes === 'number' && value.writtenBytes > 0
}
