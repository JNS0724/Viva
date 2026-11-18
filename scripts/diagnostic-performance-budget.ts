/** The absolute cap fails CI. Intermediate regressions also require review against the actual interaction. */
export function diagnosticLatencyBudget(disabledMs: number, enabledMs: number) {
  const deltaMs = enabledMs - disabledMs
  const deltaPercent = deltaMs / disabledMs * 100
  const originalTarget = deltaPercent <= 5 && deltaMs <= 10
  const acceptableLatency = Number.isFinite(deltaPercent) && deltaMs <= 10
  const reviewInteraction = acceptableLatency && !originalTarget && deltaMs > 2
  return { deltaMs, deltaPercent, originalTarget, acceptableLatency, reviewInteraction }
}
export function healthyDiagnosticSample(value: unknown) {
  if (!value || typeof value !== 'object') return false
  return 'droppedCount' in value && value.droppedCount === 0 && 'untrackedCount' in value && value.untrackedCount === 0
    && 'queuedBytes' in value && value.queuedBytes === 0 && 'activeCount' in value && value.activeCount === 0
    && 'writtenBytes' in value && typeof value.writtenBytes === 'number' && value.writtenBytes > 0
}

export function reportInteractionReview(name: string, sample: ReturnType<typeof diagnosticLatencyBudget>) {
  if (sample.reviewInteraction) {
    const prefix = process.env.GITHUB_ACTIONS === 'true' ? '::warning::' : ''
    console.warn(prefix + name + ' P95 increased by ' + sample.deltaMs.toFixed(2) + ' ms; review the measured interaction before release.')
  }
}
