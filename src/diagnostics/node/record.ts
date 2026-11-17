import { COMPONENTS, EVENTS, ID_KEYS, METRIC_KEYS, OPERATIONS, REASONS, STAGES } from '../contracts.ts'
import { BUILD_COMMIT } from '../build-info.ts'
import type { DiagnosticEvent, DiagnosticFields, DiagnosticContext, DiagnosticComponent } from '../contracts.ts'
import { diagnosticAlias } from './identity.ts'
import type { DiagnosticIdentity } from './identity.ts'

const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const member = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value)
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9a-zA-Z.-]+)?$/
const OPAQUE_ID = /^(?:[a-f0-9]{16}|[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/
const OUTCOMES = ['completed', 'failed', 'timed_out', 'cancelled', 'late_completed'] as const
const version = (value: unknown) => typeof value === 'string' && value.length <= 48 && VERSION.test(value) ? value : 'unknown'
export function safeDiagnosticEvent(raw: unknown): DiagnosticEvent | undefined {
  try {
    if (!object(raw)) return
    // Read each envelope field once: a getter must not change a validated name before it is copied.
    const event = raw.event, operation = raw.operation
    if (!member(EVENTS, event) || !member(OPERATIONS, operation)) return
    const result: DiagnosticEvent = { event, operation }
    const debug = raw.debug, stage = raw.stage, reason = raw.reason, outcome = raw.outcome
    if (debug === true) result.debug = true
    if (member(STAGES, stage)) result.stage = stage
    if (member(REASONS, reason)) result.reason = reason
    if (member(OUTCOMES, outcome)) result.outcome = outcome
    let identities: DiagnosticFields['identities']
    let metrics: DiagnosticFields['metrics']
    const rawIdentities = raw.identities, rawMetrics = raw.metrics
    if (object(rawIdentities)) for (const key of ID_KEYS) {
      const value = rawIdentities[key]
      if (typeof value === 'string' && value.length <= 512 || typeof value === 'number' && Number.isSafeInteger(value)) { identities ??= {}; identities[key] = value }
    }
    if (object(rawMetrics)) for (const key of METRIC_KEYS) {
      const value = rawMetrics[key]
      if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) { metrics ??= {}; metrics[key] = value }
    }
    if (identities) result.identities = identities
    if (metrics) result.metrics = metrics
    return result
  } catch { return undefined }
}
export interface StoredDiagnostic extends DiagnosticEvent {
  level?: 20 | 30 | 40 | 50
  schemaVersion: 1; time: string; sequence: number; component: DiagnosticComponent
  processInstanceId: string; diagnosticRunId: string; traceId: string; spanId: string; parentSpanId?: string
  appVersion: string; platform: string; arch: string
  monotonicMs?: number
  componentVersion?: string
  buildCommit?: string
}
type Aliases = Pick<StoredDiagnostic, 'traceId' | 'spanId' | 'parentSpanId' | 'processInstanceId' | 'diagnosticRunId'>
/** Both caches have fixed capacities; completed promises cannot grow diagnostic metadata indefinitely. */
export function diagnosticRecordFormatter(identity: DiagnosticIdentity, base: { component: DiagnosticComponent; instance: string; version: string; componentVersion?: string }) {
  const contexts = new Map<DiagnosticContext, Aliases>()
  // Only fixed-length opaque correlation IDs are cached; text and configurable names are never keys.
  const recent = new Map<string, string>()
  const contextAlias = (value: string) => {
    let alias = recent.get(value)
    if (!alias) {
      alias = diagnosticAlias(identity, value)
      if (recent.size >= 128) recent.delete(recent.keys().next().value!)
      recent.set(value, alias)
    }
    return alias
  }
  const diagnosticRunId = diagnosticAlias(identity, identity.runId), processInstanceId = diagnosticAlias(identity, base.instance)
  const aliasIdentity = (value: string | number) => typeof value === 'string' && OPAQUE_ID.test(value) ? contextAlias(value) : diagnosticAlias(identity, value)
  return (event: DiagnosticEvent, context: DiagnosticContext, sequence: number, time: string, monotonicMs?: number) => {
    let aliases = contexts.get(context)
    if (!aliases) {
      aliases = { diagnosticRunId, processInstanceId, traceId: contextAlias(context.traceId), spanId: contextAlias(context.spanId),
        ...(context.parentSpanId ? { parentSpanId: contextAlias(context.parentSpanId) } : {}) }
      if (contexts.size >= 128) contexts.delete(contexts.keys().next().value!)
      contexts.set(context, aliases)
    }
    return makeDiagnosticFields(event, context, identity, { ...base, sequence, time, aliases, monotonicMs, aliasIdentity })
  }
}
interface RecordBase { component: DiagnosticComponent; instance: string; version: string; componentVersion?: string; sequence: number; time: string; aliases?: Aliases; monotonicMs?: number; aliasIdentity?: (value: string | number) => string }
export function makeDiagnosticRecord(event: DiagnosticEvent, context: DiagnosticContext, identity: DiagnosticIdentity, base: RecordBase): StoredDiagnostic {
  return { component: base.component, ...makeDiagnosticFields(event, context, identity, base) }
}
function makeDiagnosticFields(event: DiagnosticEvent, context: DiagnosticContext, identity: DiagnosticIdentity, base: RecordBase): Omit<StoredDiagnostic, 'component'> {
  let identities: DiagnosticFields['identities']
  if (event.identities) {
    identities = {}
    for (const key of ID_KEYS) {
      const value = event.identities[key]
      if (value !== undefined && value !== null) identities[key] = base.aliasIdentity ? base.aliasIdentity(value) : diagnosticAlias(identity, value)
    }
  }
  return { ...event, schemaVersion: 1, time: base.time, sequence: base.sequence,
    appVersion: version(base.version), platform: process.platform, arch: process.arch,
    componentVersion: version(base.componentVersion ?? base.version),
    buildCommit: BUILD_COMMIT, monotonicMs: base.monotonicMs ?? performance.now(),
    ...(base.aliases ?? { diagnosticRunId: diagnosticAlias(identity, identity.runId), processInstanceId: diagnosticAlias(identity, base.instance),
    traceId: diagnosticAlias(identity, context.traceId), spanId: diagnosticAlias(identity, context.spanId),
    ...(context.parentSpanId ? { parentSpanId: diagnosticAlias(identity, context.parentSpanId) } : {}) }),
    ...(identities ? { identities } : {}) }
}
/** Export reparses only our own vocabulary; raw files and unknown fields never pass through. */
export function sanitizeStoredDiagnostic(raw: unknown, exportIdentity: DiagnosticIdentity): StoredDiagnostic | undefined {
  try {
    if (!object(raw) || raw.schemaVersion !== 1 || !member(COMPONENTS, raw.component)
      || typeof raw.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw.time)
      || !Number.isSafeInteger(raw.sequence) || Number(raw.sequence) < 0) return
    const event = safeDiagnosticEvent(raw)
    if (!event) return
    for (const key of ['traceId', 'spanId', 'processInstanceId', 'diagnosticRunId']) if (typeof raw[key] !== 'string' || !/^[a-f0-9]{32}$/.test(raw[key] as string)) return
    const identities: NonNullable<DiagnosticFields['identities']> = {}
    for (const [key, value] of Object.entries(event.identities ?? {})) {
      if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) return
      identities[key as keyof typeof identities] = diagnosticAlias(exportIdentity, value)
    }
    return { ...event, ...(event.identities ? { identities } : {}), schemaVersion: 1, time: raw.time, sequence: Number(raw.sequence), component: raw.component,
      ...(raw.level === 20 || raw.level === 30 || raw.level === 40 || raw.level === 50 ? { level: raw.level } : {}),
      appVersion: version(raw.appVersion), componentVersion: version(raw.componentVersion),
      buildCommit: typeof raw.buildCommit === 'string' && /^[a-f0-9]{7,40}$/.test(raw.buildCommit) ? raw.buildCommit : 'unknown',
      ...(typeof raw.monotonicMs === 'number' && Number.isFinite(raw.monotonicMs) && raw.monotonicMs >= 0 && raw.monotonicMs <= Number.MAX_SAFE_INTEGER ? { monotonicMs: raw.monotonicMs } : {}),
      platform: member(['darwin', 'win32', 'linux'] as const, raw.platform) ? raw.platform : 'unknown',
      arch: member(['arm64', 'x64', 'ia32', 'arm'] as const, raw.arch) ? raw.arch : 'unknown',
      traceId: diagnosticAlias(exportIdentity, String(raw.traceId)), spanId: diagnosticAlias(exportIdentity, String(raw.spanId)),
      processInstanceId: diagnosticAlias(exportIdentity, String(raw.processInstanceId)), diagnosticRunId: diagnosticAlias(exportIdentity, String(raw.diagnosticRunId)),
      ...(typeof raw.parentSpanId === 'string' && /^[a-f0-9]{32}$/.test(raw.parentSpanId) ? { parentSpanId: diagnosticAlias(exportIdentity, raw.parentSpanId) } : {}) }
  } catch { return undefined }
}
