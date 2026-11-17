import type { MemorySource, MemoryStore } from './ports/store.ts'
import type { MemoryNotes } from './ports/notes.ts'
import type { DocumentExternalEdit, DocumentSourceRef, MemoryDocuments } from './ports/documents.ts'
import type { Effects, Effect, Outcome } from './ports/effects.ts'
import type { MemoryFileCatalog, MemoryFileIdentity } from './ports/file-index.ts'
import type { MemoryIdentity } from './ports/runtime.ts'
import { availableDocumentSourceSpans, documentSourceRestricted } from './memory-document-restrictions.ts'
import { dreamReviewSchema, validateDreamReview } from './memory-dream-evidence.ts'
import { DREAM_VERIFY_SYSTEM } from './memory-dream-prompts.ts'
import { readMemoryLines, parseMemoryDocument } from './memory-document.ts'

const SCAN = 'memory.file-scan', RESCAN = 'memory.file-rescan'
type ExternalPolicyInput = Pick<DocumentExternalEdit, 'workspace' | 'id' | 'path' | 'sources'>
export interface ExternalEditPolicy {
  documents: Pick<MemoryDocuments, 'registered' | 'read' | 'sourceRestrictions' | 'supersessions'> & Partial<Pick<MemoryDocuments, 'projectErasedLocators'>>
  source(id: string): MemorySource | undefined
  sourceToken(source: MemorySource): string
  sourceWorkspace(source: MemorySource): string
  readable(id: string): boolean
  hash(value: string): string
}
/** The external edit policy does not read edited bytes or depend on an initialized
 * notes instance. Node separately enforces the persisted ledger and physical hash CAS. */
function externalEditState(input: ExternalPolicyInput, policy: ExternalEditPolicy): { token: string, sourceIds: string[] } | null {
  try { return inspectExternalEditState(input, policy) } catch { return null }
}
function inspectExternalEditState(input: ExternalPolicyInput, policy: ExternalEditPolicy): { token: string, sourceIds: string[] } | null {
  const restrictions = policy.documents.sourceRestrictions(input.workspace)
  const registry = policy.documents.registered(input.workspace)
  const validSources = (refs: readonly DocumentSourceRef[]) => refs.length > 0 && refs.every(ref => {
    const original = policy.source(ref.id)
    return original?.text && !original.withdrawn && policy.readable(ref.id)
      && policy.sourceWorkspace(original) === input.workspace && policy.sourceToken(original) === ref.token
      && (!ref.spans || ref.spans.length > 0 && ref.spans.every(span => Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end)
        && span.start >= 0 && span.end > span.start && span.end <= original.text!.length))
      && !documentSourceRestricted(ref, restrictions)
  })
  if (!validSources(input.sources)) return null
  const own = registry.find(row => row.id === input.id)
  if (own && (own.path !== input.path || own.state !== 'active')) return null
  const sourceIds = new Set(input.sources.map(ref => ref.id))
  const chain: unknown[] = []
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (path: string): boolean => {
    if (visiting.has(path)) return false
    if (visited.has(path)) return true
    visiting.add(path)
    const relations = policy.documents.supersessions(input.workspace, path)
    chain.push({ path, relations })
    for (const relation of relations) {
      const replacement = registry.find(row => row.id === relation.documentId)
      if (!replacement || replacement.state !== 'active' || !validSources(replacement.sources)) return false
      // Registered metadata alone cannot authorize a replacement whose physical file
      // has since changed. The edited target is the sole exception: Node owns its double CAS.
      if (replacement.id !== input.id) {
        const current = policy.documents.read(input.workspace, replacement.path)
        if (!current || current.id !== replacement.id || current.revision !== replacement.revision
          || current.usageVersion !== replacement.usageVersion || !current.corrections.some(item => item.operationId === relation.operationId)) return false
      }
      chain.push(replacement)
      replacement.sources.forEach(ref => sourceIds.add(ref.id))
      // Same-document corrections describe a previous revision of this identity.
      if (replacement.path !== path && !visit(replacement.path)) return false
    }
    visiting.delete(path); visited.add(path)
    return true
  }
  if (!visit(input.path)) return null
  return { token: policy.hash(JSON.stringify({ workspace: input.workspace, id: input.id, path: input.path, sources: input.sources, own, chain })), sourceIds: [...sourceIds] }
}
export function externalEditPolicyToken(input: ExternalPolicyInput, policy: ExternalEditPolicy): string | null {
  return externalEditState(input, policy)?.token ?? null
}
export function currentExternalEdit(input: DocumentExternalEdit, policy: ExternalEditPolicy): boolean {
  try { return Boolean(input.policyToken) && externalEditPolicyToken(input, policy) === input.policyToken } catch { return false }
}

export interface FileScanResult {
  operationId: string
  status: 'pending' | 'completed'
  scanned: number
  accepted: number
  renamed: number
  missing: number
  quarantined: number
  reasons: Record<string, number>
}
interface ScanWork { identity: MemoryFileIdentity, observedRevision: string, path: string, kind: 'modified' | 'rename', operationId: string }
interface ScanPlan { result: FileScanResult, work: ScanWork[], position: number }
export type FileMaintenanceCalculate = (request: {
  job: Effect, system: string, input: object, sourceIds(): readonly string[], current(): boolean,
}) => Promise<string | undefined>
const blank = (operationId: string): FileScanResult => ({ operationId, status: 'pending', scanned: 0, accepted: 0, renamed: 0, missing: 0, quarantined: 0, reasons: {} })
const quarantine = (result: FileScanResult, reason: string) => { result.quarantined++; result.reasons[reason] = (result.reasons[reason] ?? 0) + 1 }

/** Filesystem observations never acquire user authorship. Only an accepted identity's
 * original evidence can authorize an edit; new or ambiguous files remain isolated. */
export function createMemoryFileMaintenance({ notes, documents, catalog, effects, commands, identity, now,
  source, sourceToken, sourceWorkspace, readable, materialAllowed, calculate, mutate, changed = () => {}, intervalMs = 30_000 }: {
  notes: MemoryNotes, documents: MemoryDocuments, catalog: MemoryFileCatalog, effects: Effects,
  commands: Pick<MemoryStore, 'command' | 'recordCommand' | 'tx'>, identity: MemoryIdentity, now(): number,
  source(id: string): MemorySource | undefined, sourceToken(source: MemorySource): string, sourceWorkspace(source: MemorySource): string,
  readable(id: string): boolean, materialAllowed(text: string, refs: readonly DocumentSourceRef[]): boolean,
  calculate: FileMaintenanceCalculate, mutate<T>(write: () => T): Promise<T>, changed(): void, intervalMs?: number,
}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) throw new Error('invalid-file-scan-interval')
  let closed = false
  const policy: ExternalEditPolicy = { documents, source, sourceToken, sourceWorkspace, readable, hash: identity.hash }
  const commandKey = (operationId: string) => `${RESCAN}:${operationId}`
  function registered(): MemoryFileIdentity[] {
    const daily = notes.registered().map(row => ({ workspace: row.workspace, id: row.key, path: row.path, revision: row.file_revision,
      usageVersion: row.revision, kind: 'daily' as const, day: row.day, updatedAt: row.updatedAt, sources: row.sources, policyToken: '' }))
    const scopes = new Set([...daily.map(row => row.workspace), ...documents.workspaces()])
    return [...daily, ...[...scopes].flatMap(workspace => documents.registered(workspace).map(row => ({ ...row,
      kind: 'digest' as const, updatedAt: 0, policyToken: '' })))].map(row => ({ ...row, policyToken: externalEditPolicyToken(row, policy) ?? '' }))
  }
  function renamePolicy(row: MemoryFileIdentity): string {
    const state = row.kind === 'daily' ? notes.registered().find(item => item.key === row.id && item.workspace === row.workspace)?.state
      : documents.registered(row.workspace).find(item => item.id === row.id)?.state
    if (!state || state === 'forgotten' || state === 'withdrawing' || !row.sources.length || row.sources.some(ref => {
      const original = source(ref.id)
      return !original?.text || !readable(ref.id) || original.withdrawn || sourceWorkspace(original) !== row.workspace || sourceToken(original) !== ref.token
    })) return ''
    // Moving unchanged bytes does not grant permission to use a disabled document.
    return identity.hash(JSON.stringify([row.workspace, row.id, row.path, row.revision, row.usageVersion, row.sources, state]))
  }
  function scanPlan(operationId: string): ScanPlan {
    const result = blank(operationId), work: ScanWork[] = [], rows = registered()
    for (const workspace of new Set(rows.map(row => row.workspace))) {
      for (const change of catalog.scan(workspace, rows.filter(row => row.workspace === workspace))) {
        result.scanned++
        if (change.kind === 'unchanged') continue
        if (change.kind === 'missing') { result.missing++; continue }
        if (change.kind === 'quarantined') { quarantine(result, change.reason); continue }
        if (change.kind === 'added') {
          // Day indexes are generated navigation, not independent evidence documents.
          if (!rows.some(row => row.workspace === workspace && row.kind === 'daily' && change.file.path === `daily/${row.day}.md`)) quarantine(result, 'unregistered')
          continue
        }
        const identitySnapshot = { ...change.identity, policyToken: change.kind === 'rename' ? renamePolicy(change.identity) : change.identity.policyToken }
        if (!identitySnapshot.policyToken) { quarantine(result, 'restricted'); continue }
        const operationId = `file-change:${identity.hash(JSON.stringify([change.kind, identitySnapshot, change.file.path, change.file.revision]))}`
        work.push({ identity: identitySnapshot, path: change.file.path, observedRevision: change.file.revision, kind: change.kind, operationId })
      }
    }
    return { result, work, position: 0 }
  }
  function observation(work: ScanWork) {
    const rows = registered().filter(row => row.workspace === work.identity.workspace)
    const current = rows.find(row => row.id === work.identity.id)
    if (!current || current.path !== work.identity.path || current.revision !== work.identity.revision
      || current.usageVersion !== work.identity.usageVersion || (work.kind === 'rename' ? renamePolicy(current) : current.policyToken) !== work.identity.policyToken) return null
    const change = catalog.scan(work.identity.workspace, rows).find(change => (change.kind === 'modified' || change.kind === 'rename')
      && change.identity.id === work.identity.id && change.file.path === work.path && change.file.revision === work.observedRevision)
    return change?.kind === work.kind ? change.file : null
  }
  function status(operationId: string): FileScanResult | null {
    const receipt = commands.command(commandKey(operationId))
    if (receipt) {
      if (receipt.kind !== RESCAN) throw new Error('memory-file-operation-mismatch')
      return JSON.parse(receipt.payload) as FileScanResult
    }
    const pending = effects.get(RESCAN, operationId)
    return pending ? (pending.payload as Partial<ScanPlan>)?.result ?? blank(operationId) : null
  }
  function rescan(operationId: string) {
    if (!operationId.trim() || operationId.length > 256) throw new Error('invalid-file-operation')
    if (closed) throw new Error('memory-file-maintenance-closed')
    if (!status(operationId)) commands.tx(() => effects.queue(RESCAN, operationId, {}))
    return status(operationId)!
  }
  async function process(job: Effect, work: ScanWork): Promise<'accepted' | 'renamed' | 'quarantined' | 'retry'> {
    const prior = commands.command(work.operationId)
    if (prior) {
      if (prior.kind !== RESCAN || !['accepted', 'renamed', 'quarantined'].includes(prior.payload)) throw new Error('memory-file-operation-mismatch')
      return prior.payload as 'accepted' | 'renamed' | 'quarantined'
    }
    const store = work.identity.kind === 'daily' ? notes : documents
    if (store.reconciliationState(work.operationId, work.kind === 'modified' ? 'edit' : 'rename') === 'done') {
      changed()
      return settle(work.kind === 'modified' ? 'accepted' : 'renamed')
    }
    const current = () => !closed && effects.holds(job) && Boolean(observation(work))
    const observed = observation(work)
    let result: 'accepted' | 'renamed' | 'quarantined' = 'quarantined'
    if (observed && current()) {
      if (work.kind === 'rename') {
        result = await mutate(() => {
          if (!current()) return 'quarantined'
          const input = { operationId: work.operationId, workspace: work.identity.workspace, id: work.identity.id,
            from: work.identity.path, to: work.path, revision: work.identity.revision, usageVersion: work.identity.usageVersion }
          const accepted = work.identity.kind === 'daily' ? notes.reconcileRename(input) : documents.reconcileRename(input)
          if (accepted) changed()
          return accepted ? 'renamed' : 'quarantined'
        })
      } else {
        const beforeDocument = work.identity.kind === 'digest' ? documents.acceptedSnapshot(work.identity.workspace, work.identity.id) : null
        const before = beforeDocument?.markdown
        const project = (text: string) => documents.projectErasedLocators?.(work.identity.workspace, text) ?? text
        if (project(observed.markdown) !== observed.markdown) return settle('quarantined')
        if ((work.identity.kind === 'daily' || before && identity.hash(before) === work.identity.revision && materialAllowed(before, work.identity.sources))
          && materialAllowed(observed.markdown, work.identity.sources)) {
          const restrictions = documents.sourceRestrictions(work.identity.workspace)
          const anchors = documents.supersessions(work.identity.workspace, work.identity.path).filter(item => !(item.documentId === beforeDocument?.id
            && beforeDocument.corrections.some(own => own.operationId === item.operationId)))
          const preserved = anchors.every(item => readMemoryLines(observed.markdown, item.startLine, item.endLine) === item.text)
          if (preserved) {
            try { parseMemoryDocument(observed.markdown) } catch { return settle('quarantined') }
            const requestSources = externalEditState(work.identity, policy)?.sourceIds ?? work.identity.sources.map(ref => ref.id)
            const raw = await calculate({ job, system: `${DREAM_VERIFY_SYSTEM}\nThis is an externally edited existing file, not new user evidence. Only REFINE or CORRECT is allowed. Daily files allow REFINE only: no old accepted body is supplied, so independently verify the complete replacement summary against the same canonical sources; do not claim comparison against a previous daily body. Preserve every existing supersession anchor.`,
              input: { ...(before === undefined ? {} : { before: { path: work.identity.path, revision: work.identity.revision, markdown: project(before) } }), proposed: observed.markdown,
                kind: work.identity.kind, applicability: anchors, canonicalSources: work.identity.sources.map(ref => {
                  const original = source(ref.id)!
                  return { sourceId: ref.id, version: original.version, author: original.author,
                    text: project((() => {
                      const text = original.text ?? '', spans = availableDocumentSourceSpans(text, ref, restrictions)
                      let cursor = 0, output = ''
                      for (const span of spans) { output += text.slice(cursor, span.start).replace(/[^\r\n]/g, ' ') + text.slice(span.start, span.end); cursor = span.end }
                      return output + text.slice(cursor).replace(/[^\r\n]/g, ' ')
                    })()), question: null,
                    questionUnavailable: original.author === 'answer' || Boolean(original.question), at: original.at, timezone: original.timezone }
                }) }, sourceIds: () => requestSources, current })
            if (raw === undefined) return current() ? 'retry' : settle('quarantined')
            if (!current()) return settle('quarantined')
            let review: ReturnType<typeof validateDreamReview> | undefined, action: 'REFINE' | 'CORRECT' | undefined
            try {
              const value = dreamReviewSchema.parse(JSON.parse(raw.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')))
              if (value.verdict === 'verified' && (value.action === 'REFINE' || value.action === 'CORRECT')
                && (work.identity.kind !== 'daily' || value.action === 'REFINE')) {
                action = value.action
                review = validateDreamReview({ value, action, sources: work.identity.sources, source,
                  reads: before === undefined ? [] : [{ path: work.identity.path, revision: work.identity.revision, markdown: before }],
                  unitSources: [work.identity.sources.map(ref => ref.id)], restricted: ref => documentSourceRestricted(ref, restrictions) })
              }
            } catch { /* Invalid or unsupported semantics remain quarantined. */ }
            if (review?.verdict === 'verified' && action) {
              const input: DocumentExternalEdit = { operationId: work.operationId, workspace: work.identity.workspace, id: work.identity.id,
                path: work.identity.path, expectedRevision: work.identity.revision, expectedUsageVersion: work.identity.usageVersion,
                observedRevision: observed.revision, sources: work.identity.sources, policyToken: work.identity.policyToken, action,
                corrections: review.corrections }
              result = await mutate(() => {
                if (!current() || !currentExternalEdit(input, policy)) return 'quarantined'
                const accepted = work.identity.kind === 'daily' ? notes.reconcileEdit(input) : documents.reconcileEdit(input)
                if (accepted) changed()
                return accepted ? 'accepted' : 'quarantined'
              })
            }
          }
        }
      }
    }
    return settle(result)
    function settle(value: 'accepted' | 'renamed' | 'quarantined') {
      commands.tx(() => { if (!commands.command(work.operationId)) commands.recordCommand(work.operationId, RESCAN, value, null) })
      return value
    }
  }
  effects.runs(RESCAN, async jobs => {
    const results = new Map<string, Outcome>()
    for (const job of jobs) {
      if (closed) { results.set(job.key, 'wait'); continue }
      try {
        let plan = job.payload as Partial<ScanPlan>
        if (!plan.result || !plan.work) {
          plan = scanPlan(job.key)
          if (!effects.amend(job, plan)) { results.set(job.key, 'done'); continue }
        }
        const active = plan as ScanPlan
        let retry = false
        for (; active.position < active.work.length; active.position++) {
          const result = await process(job, active.work[active.position]!)
          if (result === 'retry') { retry = true; break }
          if (result === 'quarantined') quarantine(active.result, 'unverified-or-changed')
          else active.result[result]++
          if (!effects.amend(job, { ...active, position: active.position + 1 })) break
        }
        if (retry) { results.set(job.key, 'retry'); continue }
        if (!effects.holds(job) || closed) { results.set(job.key, 'wait'); continue }
        commands.tx(() => {
          const result = { ...active.result, status: 'completed' as const }
          if (!commands.command(commandKey(job.key))) commands.recordCommand(commandKey(job.key), RESCAN, JSON.stringify(result), null)
          effects.finishGeneration(job)
        })
        results.set(job.key, 'done')
      } catch { results.set(job.key, 'retry') }
    }
    return results
  })
  effects.runs(SCAN, async jobs => {
    const outcomes = new Map<string, Outcome>()
    for (const job of jobs) {
      if (closed) { outcomes.set(job.key, 'wait'); continue }
      commands.tx(() => {
        rescan(`periodic:${job.generation}`)
        effects.finishGeneration(job)
        effects.queue(SCAN, 'all', {}, now() + intervalMs)
      })
      outcomes.set(job.key, 'done')
    }
    return outcomes
  })
  return { rescan, status, start() { if (!closed && !effects.get(SCAN, 'all')) effects.queue(SCAN, 'all', {}) }, close() { closed = true } }
}
