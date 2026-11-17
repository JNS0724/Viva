import { z } from 'zod'

/** Pinned ReMe b13034ba document protocol. Buckets organize documents, not predicates. */
export const digestBuckets = Object.freeze(['personal', 'procedure', 'wiki'] as const)
export type DigestBucket = typeof digestBuckets[number]
export const digestActions = Object.freeze(['CREATE', 'CORROBORATE', 'REFINE', 'CORRECT'] as const)
export type DigestAction = typeof digestActions[number]

/** Portable workspace-relative path. The backend additionally checks symlinks and ownership. */
export function validMemoryPath(value: string): boolean {
  if (!value || value.startsWith('/') || /[\\\u0000-\u001f\u007f:#|\[\]<>?*"]/u.test(value)) return false
  return value.split('/').every(part => part !== '' && part !== '.' && part !== '..' &&
    !/[. ]$/u.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))
}

export const memoryFilePath = z.string().refine(validMemoryPath, 'invalid-memory-path')
export const digestPath = memoryFilePath.refine(value =>
  /^digest\/(personal|procedure|wiki)\/.+\.md$/u.test(value), 'invalid-digest-path')
export const dailyPath = memoryFilePath.refine(value =>
  /^daily\/\d{4}-\d{2}-\d{2}(?:\/.+)?\.md$/u.test(value), 'invalid-daily-path')

const bucket = z.string().transform((value): DigestBucket =>
  digestBuckets.includes(value as DigestBucket) ? value as DigestBucket : 'wiki')
export const dreamUnitSchema = z.strictObject({
  name: z.string().trim().min(1),
  bucket,
  summary: z.string().trim().min(1),
  paths: z.array(dailyPath).min(1),
})
export type DreamUnit = z.output<typeof dreamUnitSchema>

/** Validate before merging, so an unknown path can never disappear into a duplicate. */
export function parseDreamUnits(value: unknown, changedPaths: ReadonlySet<string>, maxUnits: number): DreamUnit[] {
  if (!Number.isSafeInteger(maxUnits) || maxUnits < 0) throw new Error('invalid-unit-budget')
  const { units } = z.strictObject({ units: z.array(dreamUnitSchema).max(maxUnits) }).parse(value)
  for (const unit of units) {
    if (unit.paths.some(path => !changedPaths.has(path))) throw new Error('unknown-dream-source')
  }
  return mergeDreamUnits(units)
}

/** ReMe merge_units: case-insensitive name, union paths, richer summary, first bucket. */
export function mergeDreamUnits(units: readonly DreamUnit[]): DreamUnit[] {
  const merged = new Map<string, DreamUnit>()
  for (const unit of units) {
    const key = unit.name.toLowerCase()
    const previous = merged.get(key)
    merged.set(key, previous ? {
      ...previous,
      summary: unit.summary.length > previous.summary.length ? unit.summary : previous.summary,
      paths: [...new Set([...previous.paths, ...unit.paths])].sort(),
    } : { ...unit, paths: [...new Set(unit.paths)] })
  }
  return [...merged.values()]
}

export const integrateReceiptSchema = z.strictObject({
  action: z.enum(digestActions),
  target_path: digestPath,
  note: z.string().trim().min(1),
})
export type IntegrateReceipt = z.output<typeof integrateReceiptSchema>

/** This validates the receipt's shape/target only; authorization and evidence remain Runtime duties. */
export function parseIntegrateReceipt(value: unknown, writtenPaths: readonly string[]): IntegrateReceipt {
  const receipt = integrateReceiptSchema.parse(value)
  const targets = new Set(writtenPaths)
  if (targets.size !== 1 || !targets.has(receipt.target_path)) throw new Error('integrate-target-mismatch')
  return receipt
}
