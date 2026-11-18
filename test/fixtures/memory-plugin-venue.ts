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
  archive: '萤火读书会资料归档',
  summary: '萤火读书会资料按讨论主题归档。',
  target: 'digest/wiki/firefly-archive.md',
})
type Part = { type?: string, id?: string, name?: string, text?: string, content?: unknown, tool_use_id?: string, is_error?: boolean }
type Request = { system?: string | Array<{ text?: string }>, tools?: Array<{ name?: string }>, messages?: Array<{ role?: string, content?: string | Part[] }> }
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
  const stages: string[] = [], tools: string[] = [], succeeded = new Set<string>()
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
      return { text: JSON.stringify({ units: notes.length ? [{ name: venue.topic, bucket: 'wiki', summary: '读书会场地候选与入口条件待核实', paths: notes.map(note => note.path) },
        { name: venue.archive, bucket: 'wiki', summary: venue.summary, paths: notes.map(note => note.path) }] : [] }) }
    }
    if (system === DREAM_INTEGRATE_SYSTEM) {
      const job = JSON.parse(text(first?.content)) as { unit: { name: string, paths: string[] } }
      const invoked = messages.flatMap(message => message.role === 'assistant' ? parts(message.content).filter(part => part.type === 'tool_use') : [])
      if (!invoked.length) stages.push(job.unit.name === venue.topic ? 'integrate:skip' : 'integrate:create')
      if (job.unit.name === venue.topic) return { text: JSON.stringify({ status: 'skip', reason: '场地尚未选定。' }) }
      assert.equal(job.unit.name, venue.archive)
      const placeholder = '读书会保留活动资料。'
      const actions = [
        { name: 'node_search', input: { query: venue.archive } },
        ...job.unit.paths.map(path => ({ name: 'read', input: { path } })),
        { name: 'frontmatter_read', input: { path: job.unit.paths[0]! } },
        { name: 'write', input: { path: venue.target, markdown: formatMemoryDocument({ metadata: { name: venue.archive, description: '读书会资料归档方式' },
          body: `${placeholder}\n\n## Sources\n${job.unit.paths.map(path => `归档方式见 [[${path}]]。`).join('\n')}` }) } },
        { name: 'edit', input: { path: venue.target, old_text: placeholder, new_text: venue.summary } },
        { name: 'frontmatter_update', input: { path: venue.target, patch: { description: venue.summary } } },
      ]
      const results = messages.flatMap(message => message.role === 'user' ? parts(message.content).filter(part => part.type === 'tool_result') : [])
      for (const [index, call] of invoked.entries()) {
        const expected = actions[index]
        assert.ok(expected && call.id && call.name === expected.name, 'the integrate transcript contains the expected tool identity')
        const replies = results.filter(result => result.tool_use_id === call.id)
        assert.equal(replies.length, 1, `${call.name} must have exactly one real execution result`)
        const result = replies[0]!
        assert.notEqual(result.is_error, true, `${call.name} execution failed`)
        const raw: unknown = JSON.parse(typeof result.content === 'string' ? result.content : text(result.content as Part[]))
        if (call.name === 'node_search') assert.ok(Array.isArray(raw), 'node_search must return its actual node list')
        else {
          const value = json(raw)
          assert.ok(value && 'path' in expected.input && value.path === expected.input.path, `${call.name} returned the wrong document`)
          if (call.name === 'read') {
            const markdown = value.markdown
            assert.ok(typeof markdown === 'string' && venue.facts.every(fact => markdown.includes(fact)), 'read must return the actual source daily body')
          }
          else if (call.name === 'frontmatter_read') {
            const metadata = json(value.metadata)
            assert.equal(metadata?.name, venue.topic, 'frontmatter_read must return the actual source metadata')
          } else assert.equal(value.staged, true, `${call.name} must successfully stage its draft`)
        }
        if (!succeeded.has(call.id)) { succeeded.add(call.id); tools.push(call.name!) }
      }
      const action = actions[invoked.length]
      if (action) return { tool: action }
      return { text: JSON.stringify({ action: 'CREATE', target_path: venue.target, note: '用户说明了资料归档方式。' }) }
    }
    if (system === DREAM_VERIFY_SYSTEM) throw new Error('unexpected semantic review for a new digest')
    if (system === DREAM_TAG_SYSTEM) { stages.push('tag'); return { text: '{"memory_tags":["萤火读书会","归档"]}' } }
    return null
  }
  return { decide, report: () => ({ stages: [...stages], tools: [...tools] }) }
}
