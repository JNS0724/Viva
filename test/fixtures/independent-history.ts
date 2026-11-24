import { createHash } from 'node:crypto'
import { openHistoryDb } from '../../src/backend/history-db.ts'
import { normalizeMessages } from '../../src/backend/history-schema.ts'

export function openIndependentHistory(options: Parameters<typeof openHistoryDb>[0]) {
  const history = openHistoryDb(options)
  const save = history.save
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
      return { ...message, key }
    })
    return save(conversation, normalized, ...args)
  }
  return history
}
