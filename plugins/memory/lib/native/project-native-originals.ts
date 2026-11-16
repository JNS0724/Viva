import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-title-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { memoryMessageText, memoryOriginalContentDigest } from '../context-recovery.ts'
import { maskTextSpans, type TextSpan } from '../../../../src/memory/contracts/text-spans.ts'
import { nativeCompactionCopies, projectNativeCompaction } from './project-native-compactions.ts'

export type ReplicaCandidate = { messageId: string, wireText: string, contentDigest: string }
type Plan = (candidate: ReplicaCandidate) => readonly TextSpan[] | undefined

/** Native user messages may appear in both the inbox audit and the model log.
 * Authorize every physical copy before replacing any text blocks. */
export function projectNativeOriginals(events: readonly SessionEvent[], plan: Plan) {
  const digests = new Map<string, string>()
  const erasedSources = new Set<number>()
  const replace = (message: UserMessage): UserMessage => {
    if (message.source.kind !== 'user') return message
    const messageId = String(message.id)
    const wireText = memoryMessageText(message), contentDigest = memoryOriginalContentDigest(message)
    const cuts = plan({ messageId, wireText, contentDigest })
    if (!cuts?.length) return message
    if (cuts.some(({ start, end }) => !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end <= start || end > wireText.length)) throw new Error('Native erasure exceeds its text coordinates')
    const masked = maskTextSpans(wireText, cuts)
    let offset = 0
    const content = message.content.map(part => {
      if (part.type !== 'text' || !part.text) return part
      if (offset > 0) offset++
      const text = masked.slice(offset, offset + part.text.length)
      offset += part.text.length
      return text === part.text ? part : { ...part, text }
    })
    const next = { ...message, content }
    const digest = memoryOriginalContentDigest(next), previous = digests.get(messageId)
    if (previous && previous !== digest) throw new Error('Native user message copies differ')
    if (memoryMessageText(next) !== masked) throw new Error('Native text block projection did not match the requested cut')
    digests.set(messageId, digest)
    return next
  }
  const projected = events.map(event => {
    if (event.type === 'user/message') {
      const data = replace(event.data)
      if (data === event.data) return event
      erasedSources.add(event.seq)
      return { ...event, data }
    }
    if (event.type === 'agent/inbox/spliced') {
      const inserted = event.data.inserted.map(replace)
      return inserted.every((message, index) => message === event.data.inserted[index])
        ? event : { ...event, data: { ...event.data, inserted } }
    }
    return event
  })
  const compacted = nativeCompactionCopies(projected, erasedSources)
  const eventsWithTitles = projectTitles(projected, erasedSources)
  return { events: eventsWithTitles.map(event => {
    const compaction = compacted.get(event.seq)
    return compaction ? projectNativeCompaction(compaction) : event
  }), digests }
}

function projectTitles(events: readonly SessionEvent[], erasedSources: ReadonlySet<number>): readonly SessionEvent[] {
  if (!erasedSources.size) return events
  return events.map(event => {
    if (event.type !== 'session/title' && event.type !== 'session/title-llm-request') return event
    if (!event.data.messageSeqs.some(seq => erasedSources.has(seq))) return event
    if (event.type === 'session/title') {
      if (event.data.source.kind === 'user') return event
      return { ...event, data: { ...event.data, title: '…' } }
    }
    // This stock native event owns its prepared prompt. Keep the original
    // positions and non-content request metadata for native replay.
    const [message] = event.data.messages
    if (event.data.messages.length !== 1 || message?.role !== 'user' || message.source.kind !== 'dsh-session-title-llm'
      || message.content.length !== 1 || message.content[0]?.type !== 'text') throw new Error('Invalid native title request')
    return { ...event, data: { ...event.data, system: '', messages: [{ ...message, content: [{ type: 'text', text: '' }] }] } }
  })
}
