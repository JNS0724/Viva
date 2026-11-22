import { createHash } from 'node:crypto'
import { openHistoryDb } from '../../src/backend/history-db.ts'
import { normalizeMessages } from '../../src/backend/history-schema.ts'

/** Storage-only fixtures publish independent committed replies before saving their renderer copies. */
export function openIndependentHistory(options: Parameters<typeof openHistoryDb>[0]) {
  const history = openHistoryDb(options)
  const save = history.save
  const retainMessage = history.retainMessage
  history.retainMessage = (message, session) => (message.role === 'assistant' && !message.key ? message : retainMessage(message, session))
  history.save = (conversation, messages, ...args) => {
    const prior = history.get(conversation.id)?.messages ?? []
    const copied = args[0]?.copy
    const inherited = copied ? history.get(copied.from)?.messages.slice(0, copied.count) ?? [] : []
    const known = [...prior, ...inherited]
    const normalized = normalizeMessages(messages).map((message, index) => {
      if (message.role !== 'assistant' || !message.text) return message
      const previous = known.find(item => message.key && item.key === message.key)
        ?? prior[index]
      const key = message.key ?? (previous?.role === message.role && previous.text === message.text ? previous.key : undefined)
        ?? createHash('sha256').update(JSON.stringify([conversation.id, index, message.text])).digest('hex')
      if (previous?.key !== key || previous.text !== message.text) {
        if (!conversation.sessionId) throw new Error('An independent fixture reply needs its native session identity')
        history.bindGeneratedCopy(conversation.sessionId, key, 'assistant', message.text, [{ sources: [], fileRanges: [] }])
      }
      return { ...message, key }
    })
    return save(conversation, normalized, ...args)
  }
  return history
}
