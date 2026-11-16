import assert from 'node:assert/strict'
import type { MemoryCompute } from '../../src/memory/contracts/memory-contract.ts'
import type { MemoryComputeTools } from '../../src/memory/contracts/compute.ts'
import type { DigestAction, DreamUnit } from '../../src/memory/contracts/memory-file-contract.ts'
import { memoryDocumentLinks } from '../../src/memory/core/memory-dream-tools.ts'
import { formatMemoryDocument, parseMemoryDocument } from '../../src/memory/core/memory-document.ts'
import { DREAM_EXTRACT_SYSTEM, DREAM_INTEGRATE_SYSTEM, DREAM_TAG_SYSTEM, DREAM_VERIFY_SYSTEM } from '../../src/memory/core/memory-dream-prompts.ts'

/** Deterministic test provider exercising real core tool executions, not bypassing the draft boundary. */
export async function dreamModelStep(job: MemoryCompute, tools?: MemoryComputeTools, options: { empty?: boolean, name?: string, summary?: string, evidenceId?: string, action?: DigestAction } = {}) {
  if (job.system === DREAM_EXTRACT_SYSTEM) {
    const input = JSON.parse(job.input) as { notes: Array<{ path: string }> }
    return JSON.stringify({ units: options.empty ? [] : [{ name: options.name ?? 'Report', bucket: 'personal',
      summary: options.summary ?? 'Recurring report arrangement', paths: input.notes.map(note => note.path) }] })
  }
  if (job.system === DREAM_INTEGRATE_SYSTEM) {
    assert.ok(tools)
    const { unit } = JSON.parse(job.input) as { unit: DreamUnit }
    let count = 0
    const execute = async (name: string, input: Parameters<MemoryComputeTools['executeTool']>[0]['input']) => {
      const result = await tools.executeTool({ callId: String(++count), name, input })
      assert.equal(result.state, 'completed', result.content)
      return JSON.parse(result.content) as unknown
    }
    const matches = await execute('node_search', { query: unit.name }) as Array<{ path: string, name: string }>
    const existing = matches.find(item => item.name === unit.name)
    const path = existing?.path ?? `digest/${unit.bucket}/${unit.name}.md`
    const previous = existing ? await execute('read', { path }) as { markdown: string } : null
    for (const path of unit.paths) await execute('read', { path })
    const paths = [...new Set([...(previous ? memoryDocumentLinks(previous.markdown) : []), ...unit.paths])]
    const markdown = formatMemoryDocument({ metadata: { ...previous ? parseMemoryDocument(previous.markdown).metadata : {}, name: unit.name, description: unit.summary },
      body: `${unit.summary}\n\n## Sources\n${paths.map(path => `The arrangement is supported by [[${path}]].`).join('\n')}` })
    await execute('write', { path, markdown })
    return JSON.stringify({ action: options.action ?? (existing ? 'CORROBORATE' : 'CREATE'), target_path: path, note: unit.summary })
  }
  if (job.system === DREAM_VERIFY_SYSTEM) {
    const input = JSON.parse(job.input) as { action: string, canonicalSources: Array<{ sourceId: string, version: number, text: string }> }
    const sources = options.evidenceId ? input.canonicalSources.filter(source => source.sourceId === options.evidenceId) : input.canonicalSources
    return JSON.stringify({ verdict: 'verified', action: input.action, classification: input.action === 'CREATE' ? 'unrelated' : 'same_abstraction',
      checks: { attribution: true, polarity: true, time: true, conditions: true, meaning: true, sources: true, action: true },
      evidence: sources.map(source => ({ sourceId: source.sourceId, sourceVersion: source.version, start: 0, end: source.text.length,
        text: source.text, claim: options.summary ?? 'Recurring report arrangement' })), changeEvidence: [], corrections: [] })
  }
  if (job.system === DREAM_TAG_SYSTEM) return '{"memory_tags":["report"]}'
  throw new Error(`Unexpected dream fixture stage: ${job.stage}`)
}
