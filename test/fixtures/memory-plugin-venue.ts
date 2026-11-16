import assert from 'node:assert/strict'
import { formatMemoryDocument } from '../../src/memory/core/memory-document.ts'
import { NOTE_SYSTEM } from '../../src/memory/core/memory-notes.ts'
import { DREAM_EXTRACT_SYSTEM, DREAM_INTEGRATE_SYSTEM, DREAM_TAG_SYSTEM, DREAM_VERIFY_SYSTEM } from '../../src/memory/core/memory-dream-prompts.ts'

export const venue = Object.freeze({
  topic: '萤火读书会活动场地',
  facts: [
    '萤火读书会正在比较北馆和南馆两处场地，还没有决定。',
    '萤火读书会活动定在周六下午；场地要等无障碍入口确认。',
    '萤火读书会会保留通道图，方便第一次来的成员。',
    '萤火读书会的最终场地确认后才会发邀请。',
    '萤火读书会资料按讨论主题归档。',
  ],
  question: '萤火读书会最终使用北馆还是南馆，无障碍入口确认了吗？',
  answer: '萤火读书会这次确定使用北馆；无障碍入口已经确认，周六下午在北馆见面。',
  summary: '萤火读书会周六下午在北馆见面，无障碍入口已确认。',
  target: 'digest/wiki/firefly-venue.md',
  completed: '已确认读书会场地，正在按原始依据整理。',
})
type Part = { type?: string, name?: string, text?: string, content?: unknown }
type Request = { system?: string | Array<{ text?: string }>, tools?: Array<{ name?: string }>, messages?: Array<{ role?: string, content?: string | Part[] }> }
type Source = { sourceId: string, version: number, author: string, text: string, question: string | null, questionUnavailable: boolean }
const parts = (content: string | Part[] | undefined): Part[] => typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? []
const text = (content: string | Part[] | undefined) => parts(content).flatMap(part => part.text ? [part.text] : []).join('\n')
const json = (value: unknown): Record<string, unknown> | null => {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if ('text' in parsed && typeof parsed.text === 'string') return json(parsed.text)
    return parsed as Record<string, unknown>
  } catch { return null }
}

/** A deterministic provider, never a writer: every draft tool executes through the packed plugin. */
export function createVenueModelFixture() {
  const stages: string[] = [], tools: string[] = []
  let canonicalSources: Source[] = []
  const decide = (raw: object): object | null => {
    const input = raw as Request, messages = input.messages ?? []
    const system = typeof input.system === 'string' ? input.system : input.system?.map(part => part.text ?? '').join('\n') ?? ''
    const first = messages.find(message => message.role === 'user')
    if (system === NOTE_SYSTEM && JSON.stringify(messages).includes('萤火读书会')) {
      const job = JSON.parse(text(first?.content)) as { existing?: { markdown: string }, turns: Array<{ user: Array<{ text: string }> }> }
      const supplied = job.turns.flatMap(turn => turn.user.map(source => source.text))
      const facts = venue.facts.filter(fact => supplied.includes(fact) || job.existing?.markdown.includes(fact))
      return { text: JSON.stringify(facts.length ? { status: 'write', title: venue.topic, markdown: `# ${venue.topic}\n\n${facts.join('\n\n')}` } : { status: 'skip' }) }
    }
    if (system === DREAM_EXTRACT_SYSTEM) {
      const job = JSON.parse(text(first?.content)) as { notes: Array<{ path: string, markdown: string }> }
      const notes = job.notes.filter(note => note.markdown.includes('萤火读书会'))
      if (notes.length) stages.push('extract')
      return { text: JSON.stringify({ units: notes.length ? [{ name: venue.topic, bucket: 'wiki', summary: '读书会场地候选与入口条件待核实', paths: notes.map(note => note.path) }] : [] }) }
    }
    if (system === DREAM_INTEGRATE_SYSTEM) {
      const job = JSON.parse(text(first?.content)) as { unit: { paths: string[] }, clarification?: { text: string } }
      const invoked = messages.flatMap(message => message.role === 'assistant' ? parts(message.content).filter(part => part.type === 'tool_use') : [])
      if (!invoked.length) stages.push(job.clarification ? 'integrate:resumed' : 'integrate:deferred')
      if (!job.clarification) return { text: JSON.stringify({ status: 'deferred', reason: venue.question }) }
      assert.equal(job.clarification.text, venue.answer, 'only the actual Web answer may resume this work')
      const placeholder = '萤火读书会的场地仍待确认。'
      const actions = [
        { name: 'node_search', input: { query: venue.topic } },
        ...job.unit.paths.map(path => ({ name: 'read', input: { path } })),
        { name: 'frontmatter_read', input: { path: job.unit.paths[0]! } },
        { name: 'write', input: { path: venue.target, markdown: formatMemoryDocument({ metadata: { name: venue.topic, description: '待核对读书会活动安排' },
          body: `${placeholder}\n\n## Sources\n${job.unit.paths.map(path => `场地候选和入口条件的原始记录保存在 [[${path}]]；最终决定来自本次用户确认。`).join('\n')}` }) } },
        { name: 'edit', input: { path: venue.target, old_text: placeholder, new_text: venue.summary } },
        { name: 'frontmatter_update', input: { path: venue.target, patch: { description: venue.summary } } },
      ]
      const action = actions[invoked.length]
      if (action) { tools.push(action.name); return { tool: action } }
      return { text: JSON.stringify({ action: 'CREATE', target_path: venue.target, note: '用户确认了候选场地和无障碍入口；保留原始比较记录作为依据。' }) }
    }
    if (system === DREAM_VERIFY_SYSTEM) {
      stages.push('verify')
      const job = JSON.parse(text(first?.content)) as { action: string, canonicalSources: Source[], proposed: string }
      canonicalSources = job.canonicalSources
      const answer = canonicalSources.find(source => source.text === venue.answer)
      assert.ok(answer && answer.author === 'answer' && !answer.questionUnavailable && answer.question?.includes(venue.topic), 'the canonical Web answer retains its genuine question context')
      assert.ok(venue.facts.every(fact => canonicalSources.some(source => source.text === fact)), 'Verify receives the actual original Web turns')
      assert.ok(job.proposed.includes(venue.summary))
      return { text: JSON.stringify({ verdict: 'verified', action: job.action, classification: 'unrelated',
        checks: { attribution: true, polarity: true, time: true, conditions: true, meaning: true, sources: true, action: true },
        evidence: canonicalSources.filter(source => source.text.includes('萤火读书会')).map(source => ({ sourceId: source.sourceId, sourceVersion: source.version,
          start: 0, end: source.text.length, text: source.text, claim: '读书会的场地候选、入口条件和最终用户确认。' })), changeEvidence: [], corrections: [] }) }
    }
    if (system === DREAM_TAG_SYSTEM) { stages.push('tag'); return { text: '{"memory_tags":["萤火读书会","北馆","无障碍入口"]}' } }
    const lastTool = messages.filter(message => message.role === 'assistant').flatMap(message => parts(message.content)).findLast(part => part.type === 'tool_use')
    const lastUser = messages.findLast(message => message.role === 'user')
    const result = parts(lastUser?.content).find(part => part.type === 'tool_result')
    if (result && lastTool?.name === 'memory_recall') {
      const payload = json(typeof result.content === 'string' ? result.content : Array.isArray(result.content) ? text(result.content as Part[]) : null)
      const clarification = payload?.clarification
      if (clarification && typeof clarification === 'object' && 'ref' in clarification && typeof clarification.ref === 'string') {
        return { tool: { name: 'memory_clarify', input: { ref: clarification.ref } } }
      }
    }
    if (result && lastTool?.name === 'memory_clarify') {
      const payload = json(typeof result.content === 'string' ? result.content : Array.isArray(result.content) ? text(result.content as Part[]) : null)
      assert.equal(payload?.status, 'answered', 'the native Web question must actually be accepted')
      return { text: venue.completed }
    }
    return null
  }
  return { decide, report: () => ({ stages: [...stages], tools: [...tools], canonicalSources: canonicalSources.map(source => ({ ...source })) }) }
}
