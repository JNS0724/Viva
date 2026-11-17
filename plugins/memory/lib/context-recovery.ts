import { createHash } from 'node:crypto'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionEventInput } from '@deepseek-ai/dsh-session'
import type {} from './source.ts'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function memoryMessageText(message: { content: readonly { type: string, text?: string }[] }) {
  return message.content.flatMap(part => part.type === 'text' && part.text ? [part.text] : []).join('\n')
}
const originalEvents = (session: Session) => session.snapshotEvents().filter((event): event is Extract<SessionEvent, { type: 'user/message' }> =>
  event.type === 'user/message' && event.surfaceOp === 'append' && event.data.source.kind === 'user')

/** Raw originals are candidates only. The owner authenticates their source, scope and current permission. */
export function memoryRecoveryCandidates(session: Session) {
  return originalEvents(session).map(({ data: message, seq }) => ({
    messageId: String(message.id),
    text: memoryMessageText(message),
    contentDigest: memoryOriginalContentDigest(message),
    ...(seq < session.inheritedEventCount ? { inherited: true as const } : {}),
  }))
}

/** Bind a prepared recovery to the exact model-visible state, including plugin projections. */
export function memorySessionSurfaceHash(session: Session) {
  return hash({ nodes: session.surface.nodes, generation: session.surface.contentGeneration, messages: session.deriveMessages() })
}

export function memoryRecoveryMessageHash(message: UserMessage) { return hash(message) }
export function memoryOriginalContentDigest(message: Pick<UserMessage, 'content'>) { return hash(message.content) }

export function memoryRecoveryContent(selected: readonly Pick<UserMessage, 'content'>[]): UserMessage['content'] {
  return [
    { type: 'text', text: 'The previous generated context has been retired. The following are authorized earlier user messages, retained as historical context.' },
    ...selected.flatMap((original, index) => [
      { type: 'text' as const, text: `\n[Earlier user message ${index + 1}]\n` },
      ...original.content,
    ]),
    { type: 'text', text: '\n[End of earlier user messages]\n' },
  ]
}

/** One positional replacement removes assistant/tool pairs together while leaving the human event log intact. */
export function planMemoryContextRecovery(session: Session, ticketId: string, retainedMessageIds: readonly string[], replacementMessageId?: string) {
  const originals = originalEvents(session).map(event => event.data)
  const retained = new Set(retainedMessageIds)
  if (retained.size !== retainedMessageIds.length || retainedMessageIds.some(id => !originals.some(message => message.id === id))) {
    throw new Error('Recovery refers to an unavailable original message')
  }
  const selected = originals.filter(message => retained.has(message.id))
  const created = createUserMessage({
    source: { kind: 'viva-memory-recovery', ticketId, originalMessageIds: selected.map(item => String(item.id)) },
    content: memoryRecoveryContent(selected),
  })
  const message: UserMessage = replacementMessageId ? { ...created, id: MessageId(replacementMessageId) } : created
  const surface = [...session.surface.nodes]
  if (surface.length && session.eventAt(surface[0]!)?.type === 'system/message') surface.shift()
  const input: SessionEventInput = ['user/message', message, surface.length
    ? { surfaceOp: { op: 'replace', startSeq: surface[0]!, endSeq: surface.at(-1)! }, sourceEventSeqs: surface }
    : { surfaceOp: 'append' }]
  return { input, message, baseSurfaceHash: memorySessionSurfaceHash(session), replacementHash: memoryRecoveryMessageHash(message) }
}
