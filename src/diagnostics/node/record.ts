import { COMPONENTS, EVENTS, ID_KEYS, OPERATIONS, STAGES, parseDiagnosticLinks, safeDiagnosticEvent, type ValidatedDiagnosticEvent } from '../contracts.ts'
import { BUILD_COMMIT } from '../build-info.ts'
import type { DiagnosticEvent, DiagnosticFields, DiagnosticContext, DiagnosticComponent, DiagnosticLink } from '../contracts.ts'
import { diagnosticAlias, newDiagnosticIdentity } from './identity.ts'
import type { DiagnosticIdentity } from './identity.ts'

export { safeDiagnosticEvent } from '../contracts.ts'

const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const member = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value)
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9a-zA-Z.-]+)?$/
const version = (value: unknown) => typeof value === 'string' && value.length <= 48 && VERSION.test(value) ? value : 'unknown'
const captured = Symbol('captured diagnostic event')
export type CapturedDiagnosticEvent = DiagnosticEvent & { readonly [captured]: true }
/** Capture only aliases before retaining metadata. Raw text lives on this call's stack only. */
export function createDiagnosticCapture() {
  let correlation: DiagnosticIdentity | undefined
  return {
    capture(event: ValidatedDiagnosticEvent, identity: DiagnosticIdentity | undefined, mode: 'explicit' | 'bound' = 'explicit') {
      const { identities: input, ...metadata } = event
      const operationId = input?.operationId
      // This private key also matches an early start with a terminal after the disk salt is ready.
      const key = mode === 'bound' || operationId === undefined || operationId === null ? undefined : `${event.operation}:${diagnosticAlias(correlation ??= newDiagnosticIdentity(), operationId)}`
      let identities: DiagnosticFields['identities']
      if (identity && input) for (const name of ID_KEYS) {
        const value = input[name]
        if (value === undefined || value === null) continue
        // A configurable model/resource name can look like a UUID or hex ID. Never cache its raw value.
        identities ??= {}; identities[name] = diagnosticAlias(identity, value)
      }
      const partial = Boolean(input && !identity)
      const value: CapturedDiagnosticEvent = { ...metadata, [captured]: true, ...(identities ? { identities } : {}),
        ...(partial ? { reason: metadata.reason ?? 'not_ready', metrics: { ...metadata.metrics, partial: true } } : {}) }
      return { event: value, key, partial }
    },
    clear() { correlation = undefined },
  }
}
export interface StoredDiagnostic extends DiagnosticEvent {
  links?: readonly DiagnosticLink[]
  level?: 20 | 30 | 40 | 50
  schemaVersion: 1; time: string; sequence: number; component: DiagnosticComponent
  processInstanceId: string; diagnosticRunId: string; traceId: string; spanId: string; parentSpanId?: string
  appVersion: string; platform: string; arch: string
  monotonicMs?: number
  componentVersion?: string
  buildCommit?: string
}
export type StoredDiagnosticReference = Pick<StoredDiagnostic, 'event' | 'operation' | 'stage' | 'traceId' | 'spanId' | 'processInstanceId' | 'diagnosticRunId'>
/** Existing opaque aliases only; startup inspection must not retain bodies or apply a second HMAC. */
export function storedDiagnosticReference(raw: unknown): StoredDiagnosticReference | undefined {
  try {
    if (!object(raw) || raw.schemaVersion !== 1 || !member(COMPONENTS, raw.component)
      || typeof raw.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw.time)
      || !Number.isSafeInteger(raw.sequence) || Number(raw.sequence) < 0) return
    const event = raw.event, operation = raw.operation, stage = raw.stage
    const traceId = raw.traceId, spanId = raw.spanId, processInstanceId = raw.processInstanceId, diagnosticRunId = raw.diagnosticRunId
    if (!member(EVENTS, event) || !member(OPERATIONS, operation)
      || ![traceId, spanId, processInstanceId, diagnosticRunId].every(value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value))) return
    return { event, operation, ...(member(STAGES, stage) ? { stage } : {}),
      traceId: traceId as string, spanId: spanId as string, processInstanceId: processInstanceId as string, diagnosticRunId: diagnosticRunId as string }
  } catch { return undefined }
}
type Aliases = Pick<StoredDiagnostic, 'links' | 'traceId' | 'spanId' | 'parentSpanId' | 'processInstanceId' | 'diagnosticRunId'>
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
  return (event: CapturedDiagnosticEvent, context: DiagnosticContext, sequence: number, time: string, monotonicMs?: number) => {
    let aliases = contexts.get(context)
    if (!aliases) {
      aliases = { diagnosticRunId, processInstanceId, traceId: contextAlias(context.traceId), spanId: contextAlias(context.spanId),
        ...(context.links ? { links: context.links.map(link => ({ traceId: contextAlias(link.traceId), spanId: contextAlias(link.spanId) })) } : {}),
        ...(context.parentSpanId ? { parentSpanId: contextAlias(context.parentSpanId) } : {}) }
      if (contexts.size >= 128) contexts.delete(contexts.keys().next().value!)
      contexts.set(context, aliases)
    }
    return { ...event, schemaVersion: 1 as const, time, sequence,
      appVersion: version(base.version), platform: process.platform, arch: process.arch,
      componentVersion: version(base.componentVersion ?? base.version),
      buildCommit: BUILD_COMMIT, monotonicMs: monotonicMs ?? performance.now(), ...aliases }
  }
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
    const links = raw.links === undefined ? undefined : parseDiagnosticLinks(raw.links, true)
    if (raw.links !== undefined && !links) return
    return { ...event, ...(links ? { links: links.map(link => ({ traceId: diagnosticAlias(exportIdentity, link.traceId), spanId: diagnosticAlias(exportIdentity, link.spanId) })) } : {}),
      ...(event.identities ? { identities } : {}), schemaVersion: 1, time: raw.time, sequence: Number(raw.sequence), component: raw.component,
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
