import { NOTE_SYSTEM } from '../../src/memory/core/memory-notes.ts'
import { DREAM_CONSOLIDATE_SYSTEM } from '../../src/memory/core/memory-dream-prompts.ts'

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
type Part = { type?: string, text?: string }
type Request = { system?: string | Array<{ text?: string }>, messages?: Array<{ role?: string, content?: string | Part[] }> }
const parts = (content: string | Part[] | undefined): Part[] => typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? []
const text = (content: string | Part[] | undefined) => parts(content).flatMap(part => part.text ? [part.text] : []).join('\n')

/** Deterministic single-stage Dream provider for standalone smoke and benchmark harnesses. */
export function createVenueModelFixture() {
  const stages: string[] = []
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
    if (system === DREAM_CONSOLIDATE_SYSTEM) {
      const job = JSON.parse(text(first?.content)) as {
        notes: Array<{ path: string, markdown: string, sourceIds: string[] }>
        existingDigests: Array<{ path: string }>
      }
      const notes = job.notes.filter(note => note.markdown.includes('萤火读书会'))
      if (notes.length) stages.push('consolidate')
      const existing = job.existingDigests.find(doc => doc.path === venue.target)
      return {
        text: JSON.stringify({
          operations: notes.length ? [{
            action: existing ? 'REFINE' : 'CREATE',
            path: venue.target,
            name: venue.archive,
            description: venue.summary,
            body: venue.summary,
            dailyPaths: notes.map(note => note.path),
            sourceIds: [...new Set(notes.flatMap(note => note.sourceIds))],
          }] : [],
        }),
      }
    }
    return null
  }
  return { decide, report: () => ({ stages: [...stages] }) }
}
