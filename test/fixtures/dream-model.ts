import type { MemoryCompute } from '../../src/memory/contracts/memory-contract.ts'
import type { MemoryComputeTools } from '../../src/memory/contracts/compute.ts'
import { DREAM_CONSOLIDATE_SYSTEM, DREAM_PROFILE_SYSTEM } from '../../src/memory/core/memory-dream-prompts.ts'

/** Deterministic Dream test provider exercising read-only node_search/read tools before outputting JSON operations. */
export async function dreamModelStep(
  job: MemoryCompute,
  options: { empty?: boolean, name?: string, bucket?: 'personal' | 'procedure' | 'wiki', summary?: string, body?: string, evidenceId?: string, path?: string } = {},
  tools?: MemoryComputeTools,
) {
  if (job.system === DREAM_PROFILE_SYSTEM) return JSON.stringify({ action: 'NOOP' })
  if (job.system !== DREAM_CONSOLIDATE_SYSTEM) throw new Error(`Unexpected dream fixture system for stage: ${job.stage}`)
  const input = JSON.parse(job.input) as {
    existingDigestCount?: number
    notes: Array<{ path: string, sourceIds: string[] }>
  }
  if (options.empty) return JSON.stringify({ operations: [] })
  const name = options.name ?? 'Report'
  const bucket = options.bucket ?? 'personal'
  const summary = options.summary ?? 'Recurring report arrangement'
  let matchedPath: string | undefined
  if ((input.existingDigestCount ?? 0) > 0 && tools) {
    const search = await tools.executeTool({ callId: 'fixture-search', name: 'node_search', input: { query: name } })
    const parsed = JSON.parse(search.content) as Array<{ path: string, name: string }> | { nodes: Array<{ path: string, name: string }> }
    const nodes = Array.isArray(parsed) ? parsed : parsed.nodes
    const hit = options.path
      ? nodes.find(node => node.path === options.path)
      : nodes.find(node => node.name === name) ?? nodes[0]
    if (hit) {
      await tools.executeTool({ callId: 'fixture-read', name: 'read', input: { path: hit.path } })
      matchedPath = hit.path
    }
  }
  const path = matchedPath ?? options.path ?? `digest/${bucket}/${name}.md`
  const dailyPaths = input.notes.map(note => note.path)
  const availableSources = [...new Set(input.notes.flatMap(note => note.sourceIds))]
  const sourceIds = options.evidenceId ? [options.evidenceId] : availableSources
  return JSON.stringify({
    operations: [{
      action: matchedPath ? 'REFINE' : 'CREATE',
      path,
      name,
      description: summary,
      body: options.body ?? summary,
      dailyPaths,
      sourceIds,
    }],
  })
}
