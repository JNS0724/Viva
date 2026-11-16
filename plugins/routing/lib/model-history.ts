import type { Session } from '@deepseek-ai/dsh-session'
import { withoutHeaders } from '../../../src/shared/request-routing/header.ts'
import type { FastTurn } from './fast-lane.ts'

/** Model inputs use the current surface. Append history may retain retired material for UI/audit. */
export function routingModelHistory(session: Pick<Session, 'deriveMessages' | 'surface'>) {
  const generation = session.surface.contentGeneration
  const messages = session.deriveMessages()
  const text = (content: typeof messages[number]['content']) => content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
  const recent: FastTurn[] = messages.flatMap(message => message.role === 'user' || message.role === 'assistant'
    ? [{ role: message.role, text: withoutHeaders(text(message.content)) }] : []).filter(turn => turn.text.trim())
  return { recent, userTexts: messages.filter(message => message.role === 'user').map(message => text(message.content)),
    current: () => session.surface.contentGeneration === generation }
}
