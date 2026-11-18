import { parseDiagnosticContext } from '../contracts.ts'
import type { DiagnosticContext } from '../contracts.ts'

/** Operates only on our canonical JSON object encoding, retaining the original body on fallback. */
export function encodeDiagnosticEnvelope(business: Buffer, incoming: DiagnosticContext | undefined, limit: number) {
  const context = parseDiagnosticContext(incoming)
  if (!context) return { body: business, byteLength: business.length, dropped: incoming !== undefined, diagnosticBytes: 0 }
  if (business.length > limit || business[0] !== 123 || business.at(-1) !== 125) return { body: business, byteLength: business.length, dropped: true, diagnosticBytes: 0 }
  // The receiver needs the sending span, not that span's own parent (which remains in local records).
  const suffix = Buffer.from(`${business.length === 2 ? '' : ','}"diagnostics":${JSON.stringify({ version: context.version, traceId: context.traceId, spanId: context.spanId,
    ...(context.diagnosticRunId ? { diagnosticRunId: context.diagnosticRunId } : {}) })}}`)
  const diagnosticBytes = suffix.length - 1
  if (business.length + diagnosticBytes > limit) return { body: business, byteLength: business.length, dropped: true, diagnosticBytes }
  return { body: [business.subarray(0, -1), suffix] as const, byteLength: business.length + diagnosticBytes, dropped: false, diagnosticBytes }
}
