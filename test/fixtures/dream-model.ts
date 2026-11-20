import type { MemoryCompute } from '../../src/memory/contracts/memory-contract.ts'
import { DREAM_CONSOLIDATE_SYSTEM } from '../../src/memory/core/memory-dream-prompts.ts'

/** Deterministic single-stage Dream test provider producing structured consolidation JSON. */
export async function dreamModelStep(
  job: MemoryCompute,
  options: { empty?: boolean, name?: string, bucket?: 'personal' | 'procedure' | 'wiki', summary?: string, body?: string, evidenceId?: string, path?: string } = {},
) {
  if (job.system !== DREAM_CONSOLIDATE_SYSTEM) throw new Error(`Unexpected dream fixture system for stage: ${job.stage}`)
  const input = JSON.parse(job.input) as {
    notes: Array<{ path: string, sourceIds: string[] }>
    existingDigests: Array<{ path: string, name: string }>
  }
  if (options.empty) return JSON.stringify({ operations: [] })
  const name = options.name ?? 'Report'
  const bucket = options.bucket ?? 'personal'
  const summary = options.summary ?? 'Recurring report arrangement'
  const existing = options.path
    ? input.existingDigests.find(doc => doc.path === options.path)
    : input.existingDigests.find(doc => doc.name === name)
  const path = existing?.path ?? options.path ?? `digest/${bucket}/${name}.md`
  const dailyPaths = input.notes.map(note => note.path)
  const availableSources = [...new Set(input.notes.flatMap(note => note.sourceIds))]
  const sourceIds = options.evidenceId ? [options.evidenceId] : availableSources
  return JSON.stringify({
    operations: [{
      action: existing ? 'REFINE' : 'CREATE',
      path,
      name,
      description: summary,
      body: options.body ?? summary,
      dailyPaths,
      sourceIds,
    }],
  })
}
