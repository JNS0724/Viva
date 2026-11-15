import type { MemoryScope } from '../contracts/memory-contract.ts'
import { memoryRelationLabel } from './memory-facts.ts'
import { intersect, normalizeWindows, overlapWindows, sameWindows, subtract } from './memory-intervals.ts'
import type { MemoryInterval } from './memory-intervals.ts'
import type { MemoryEntry } from './ports/store.ts'

const MAX_ENTITIES = 50
const MAX_EDGE_CHECKS = 500
const MAX_VISITS = 100
const DEFAULT_LIMIT = 5

type Entry = Pick<MemoryEntry, 'id' | 'revision' | 'scope' | 'updatedAt' | 'state' | 'retention' | 'modality' | 'conditional' | 'fact' | 'windows' | 'evidence'>
type Evidence = Entry['evidence'][number]
export type MemoryRelationEntity = { scope: MemoryScope; label: string }
export type MemoryRelationProof = { edge: Evidence; windows: readonly MemoryInterval[] }
export type MemoryRelationHit<T> = {
  entry: T, path: readonly T[], hops: 1 | 2, windows: MemoryInterval[], dependencies: readonly T[],
  proofs: ReadonlyMap<number, readonly MemoryRelationProof[]>,
}

const named = (subject: string) => subject.startsWith('named:') ? memoryRelationLabel(subject.slice(6)) : ''
const entityKey = ({ scope, label }: MemoryRelationEntity) => JSON.stringify([scope.kind, scope.kind === 'user' ? null : scope.id, label])

/** Whole names and explicit query terms. Han runs within unsegmented prose do not imply a name boundary. */
export function memoryRelationQueryLabels(query: string) {
  const normalized = memoryRelationLabel(query)
  const labels = new Set([normalized])
  const quoted = /"([^"]+)"|(?<![\p{L}\p{N}])'([^']+)'(?![\p{L}\p{N}])|“([^”]+)”|‘([^’]+)’|「([^」]+)」|『([^』]+)』|【([^】]+)】|\[([^\]]+)\]|\(([^)]+)\)/gu
  const rest = normalized.replace(quoted, (_match, ...groups: unknown[]) => {
    const label = groups.slice(0, -2).find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    if (label) labels.add(label.trim())
    return ' '
  })
  const terms = /\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{M}\p{N}])+(?:[-_./@'](?:(?!\p{Script=Han})[\p{L}\p{M}\p{N}])+)*/gu
  for (const token of rest.matchAll(terms)) labels.add(token[0])
  return [...labels].filter(Boolean)
}

function add<T>(map: Map<string, T[]>, key: string, value: T) {
  const values = map.get(key)
  if (values) values.push(value)
  else map.set(key, [value])
}

/** Expand asserted named relationships using only canonical entries selected for each exact scoped entity. */
export function expandMemoryRelations<T extends Entry>({ roots, neighbors, seeds, interval, deep = false, limit = DEFAULT_LIMIT,
  retainWindows = false, disputed, evidenceAvailable = () => true, shouldStop = () => false }: {
  roots: readonly MemoryRelationEntity[], neighbors: (entity: MemoryRelationEntity) => { entries: readonly T[]; partial: boolean },
  seeds: readonly T[], interval: MemoryInterval, deep?: boolean, limit?: number, retainWindows?: boolean,
  disputed?: ReadonlySet<number>, evidenceAvailable?: (edge: Evidence) => boolean, shouldStop?: () => boolean,
}): { found: MemoryRelationHit<T>[], partial: boolean } {
  type Relation = { entry: T, subject: string, object: string, evidence: Evidence[], windows: MemoryInterval[] }
  type Supported = { entry: T, edge: Evidence }
  type Visit = { entity: MemoryRelationEntity, windows: MemoryInterval[], path: readonly T[], support: readonly Supported[], hops: 0 | 1 | 2 }
  const neighborhoods = new Map<string, { outgoing: Relation[]; incoming: Relation[] }>()
  const visited = new Map<string, Visit[]>()
  const queue: Visit[] = []
  const requested = new Set(seeds.map(seed => seed.id))
  const found = new Map<number, MemoryRelationHit<T>>()
  const unbounded = { from: null, to: null }
  const withinRecall = (first: readonly MemoryInterval[], second: readonly MemoryInterval[]) =>
    overlapWindows(first, second, retainWindows ? unbounded : interval).filter(window => intersect(window, interval))
  const evidenceWindow = (edge: Evidence) => ({ from: edge.assertedFrom, to: edge.assertedTo })
  const preferred = (left: Relation, right: Relation) => right.entry.updatedAt - left.entry.updatedAt || left.entry.id - right.entry.id
  let partial = false, checked = 0
  const exhausted = () => checked >= MAX_EDGE_CHECKS || shouldStop()

  function load(entity: MemoryRelationEntity) {
    const key = entityKey(entity)
    const known = neighborhoods.get(key)
    if (known) return known
    if (neighborhoods.size >= MAX_ENTITIES || exhausted()) { partial = true; return null }
    const result = { outgoing: [] as Relation[], incoming: [] as Relation[] }
    neighborhoods.set(key, result)
    const rows = neighbors(entity)
    partial ||= rows.partial
    for (const entry of rows.entries) {
      if (exhausted()) { partial = true; break }
      checked++
      const { fact, scope } = entry
      if (!fact || fact.polarity !== 'positive' || entry.modality !== 'asserted' || entry.conditional || disputed?.has(entry.id)
        || entry.retention !== 'retained' || (entry.state !== 'active' && entry.state !== 'superseded')) continue
      if (entityKey({ scope, label: entity.label }) !== key) continue
      const subject = named(fact.subject), object = memoryRelationLabel(fact.object)
      if (subject !== entity.label && object !== entity.label) continue
      if (fact.subject !== 'user' && !subject) continue
      const evidence = entry.evidence.filter(edge => edge.parts && evidenceAvailable(edge)
        && (fact.subject === 'user' || edge.parts.subject))
      if (!evidence.length) continue
      const windows = withinRecall(entry.windows, evidence.map(evidenceWindow))
      if (!windows.length) continue
      const record = { entry, subject, object, evidence, windows }
      if (subject === entity.label) result.outgoing.push(record)
      else result.incoming.push(record)
    }
    result.outgoing.sort(preferred)
    result.incoming.sort(preferred)
    return result
  }

  function visit(next: Visit) {
    const key = entityKey(next.entity)
    const prior = visited.get(key)
    if (prior?.some(visit => visit.hops <= next.hops && sameWindows(visit.windows, next.windows))) return
    if ((!prior && visited.size >= MAX_ENTITIES) || queue.length >= MAX_VISITS) { partial = true; return }
    add(visited, key, next)
    queue.push(next)
  }

  function confirmObject(record: Relation, windows: MemoryInterval[]) {
    const witnesses: Array<{ windows: MemoryInterval[]; support: Supported[] }> = []
    const proofs = load({ scope: record.entry.scope, label: record.object })?.outgoing ?? []
    let uncovered = windows
    for (const proof of proofs) {
      if (!uncovered.length) break
      for (const edge of proof.evidence) {
        if (!uncovered.length) break
        if (exhausted()) { partial = true; return witnesses }
        checked++
        const otherSources = record.evidence.filter(support => support.sourceId !== edge.sourceId).map(evidenceWindow)
        const applicable = withinRecall(proof.windows, [evidenceWindow(edge)])
        const supported = withinRecall(applicable, otherSources)
        const common = withinRecall(uncovered, supported)
        if (!common.length) continue
        witnesses.push({ windows: common, support: [{ entry: proof.entry, edge }] })
        uncovered = common.reduce((rest, used) => rest.flatMap(window => subtract(window, used)), uncovered)
      }
    }
    return witnesses
  }

  function include(record: Relation, current: Visit, windows: MemoryInterval[], hops: 1 | 2, support: readonly Supported[]) {
    if (requested.has(record.entry.id)) return
    const previous = found.get(record.entry.id)
    const path = [...current.path, record.entry]
    if (previous && (previous.hops < hops || (previous.hops === hops && (previous.path.length !== path.length
      || !previous.path.every((entry, index) => entry.id === path[index].id))))) {
      if (!sameWindows(windows, withinRecall(windows, previous.windows))) partial = true
      return
    }
    const samePath = previous?.hops === hops ? previous : undefined
    const dependencies = new Map(samePath?.dependencies.map(entry => [entry.id, entry]))
    const proofs = new Map(samePath?.proofs)
    for (const { entry, edge } of support) {
      const valid = withinRecall(windows, [evidenceWindow(edge)])
      if (!valid.length) continue
      const prior = proofs.get(entry.id) ?? []
      const existing = prior.find(item => item.edge.sourceId === edge.sourceId && item.edge.sourceVersion === edge.sourceVersion
        && item.edge.start === edge.start && item.edge.end === edge.end)
      proofs.set(entry.id, existing
        ? [...prior.filter(item => item !== existing), { edge, windows: normalizeWindows([...existing.windows, ...valid]) }]
        : [...prior, { edge, windows: valid }])
      dependencies.set(entry.id, entry)
    }
    if (samePath) windows = normalizeWindows([...samePath.windows, ...windows])
    found.set(record.entry.id, { entry: record.entry, path, hops, windows, dependencies: [...dependencies.values()], proofs })
  }

  const rootWindows = [retainWindows ? unbounded : interval]
  for (const entity of roots) {
    if (exhausted()) { partial = true; break }
    if (!entity.label) continue
    const neighborhood = load(entity)
    // An object mention with no independently supported subject is not an entity root.
    if (neighborhood?.outgoing.length) visit({ entity, windows: rootWindows, path: [], support: [], hops: 0 })
  }

  const depth = deep ? 2 : 1
  for (const current of queue) {
    if (exhausted()) { partial = true; break }
    const neighborhood = load(current.entity)
    if (!neighborhood) continue
    for (const record of [...neighborhood.outgoing, ...neighborhood.incoming].sort(preferred)) {
      if (exhausted()) { partial = true; break }
      checked++
      if (current.path.some(entry => entry.id === record.entry.id)) continue
      const windows = withinRecall(current.windows, record.windows)
      if (!windows.length) continue
      const outbound = record.subject === current.entity.label
      const support = [...current.support, ...record.evidence.map(edge => ({ entry: record.entry, edge }))]
      const hops = Math.max(1, current.hops) as 1 | 2
      const peer = outbound ? record.object : record.subject
      if (outbound) include(record, current, windows, hops, support)
      if (!record.object || record.subject === record.object || (outbound && current.hops >= depth)) continue
      const witnesses = confirmObject(record, windows)
      for (const witness of witnesses) {
        const witnessed = [...support, ...witness.support]
        if (!outbound) include(record, current, witness.windows, hops, witnessed)
        if (peer && current.hops < depth) {
          visit({ entity: { scope: record.entry.scope, label: peer }, windows: witness.windows,
            path: [...current.path, record.entry], support: witnessed, hops: (current.hops + 1) as 1 | 2 })
        }
      }
    }
  }
  const ranked = [...found.values()].sort((a, b) => a.hops - b.hops || b.entry.updatedAt - a.entry.updatedAt || a.entry.id - b.entry.id)
  return { found: ranked.slice(0, limit), partial: partial || ranked.length > limit }
}
