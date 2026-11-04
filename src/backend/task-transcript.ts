import { t } from '../shared/i18n/translate.ts'
import { answerText, type AnsweredQuestion, type QuestionAnswer } from '../shared/question-answer.ts'

/**
 * What a background task has said, as the history keeps it: the user's words and the agent's answers, built from
 * the ACP updates the way the window builds its conversation (renderer/state.ts, renderer/assistant-stream.ts), so
 * the backend keeps a task's words whether or not a window is there to see them. Pure and immutable.
 */

/** One message: open while the agent is still writing it; a stream's message is named by its key, with its blocks. */
export interface TranscriptMessage {
  readonly role: 'user' | 'assistant' | 'note'
  readonly text: string
  readonly open?: boolean
  readonly streamKey?: string
  readonly blocks?: ReadonlyArray<{ readonly index: number, readonly text: string }>
}
export type Transcript = readonly TranscriptMessage[]
/** A message as the history keeps it (history-db.ts save). */
export interface SavedMessage { role: string, text: string }

type Update = Readonly<Record<string, unknown>>
type Blocks = NonNullable<TranscriptMessage['blocks']>

const isRecord = (value: unknown): value is Update => Boolean(value) && typeof value === 'object'
const textOf = (value: unknown) => (typeof value === 'string' ? value : '')

/** Anything happening other than the agent writing ends what it was writing. */
export function closed(transcript: Transcript): Transcript {
  const last = transcript.at(-1)
  return last?.open ? [...transcript.slice(0, -1), { ...last, open: false }] : transcript
}

/** The user said something: words into the turn, or the next question. */
export const said = (transcript: Transcript, words: string): Transcript => [...closed(transcript), { role: 'user', text: words }]

/** The user answered what the agent asked: their reply, worded as the window words it. */
export const answered = (transcript: Transcript, questions: readonly AnsweredQuestion[], answers: readonly QuestionAnswer[]): Transcript =>
  said(transcript, answerText(questions, answers))

function contentText(content: unknown) {
  if (!isRecord(content)) return ''
  return content.type === 'text' ? textOf(content.text) : `[${textOf(content.type)}]`
}

function onChunk(transcript: Transcript, chunk: string): Transcript {
  if (!chunk) return transcript
  const last = transcript.at(-1)
  if (last?.open) return [...transcript.slice(0, -1), { ...last, text: last.text + chunk }]
  return [...transcript, { role: 'assistant', text: chunk, open: true }]
}

function settledBlocks(blocks: unknown): Blocks | null {
  if (!Array.isArray(blocks)) return null
  return blocks.filter((block): block is Update => isRecord(block) && block.type === 'text' && Boolean(textOf(block.text)))
    .map((block, index) => ({ index, text: textOf(block.text) }))
}

function withBlock(blocks: Blocks, update: Update): Blocks | null {
  if (typeof update.index !== 'number' || typeof update.text !== 'string') return null
  const prior = blocks.find((block) => block.index === update.index)
  const block = { index: update.index, text: update.kind === 'block' ? update.text : (prior?.text ?? '') + update.text }
  return prior ? blocks.map((item) => (item === prior ? block : item)) : [...blocks, block]
}

/**
 * A viva_stream update (assistant-stream.ts): text blocks build the message under their key; settled, the blocks it
 * ends with replace them, and a message left with no text goes.
 */
function onStream(transcript: Transcript, update: Update): Transcript {
  const key = textOf(update.key)
  const settled = update.kind === 'settle'
  if (!key || (!settled && update.blockType !== 'text')) return transcript
  const found = transcript.find((message) => message.streamKey === key)
  const blocks = settled ? settledBlocks(update.blocks) : withBlock(found?.blocks ?? [], update)
  if (!blocks) return transcript
  const text = blocks.map((block) => block.text).join('')
  if (!text) return found ? transcript.filter((message) => message !== found) : transcript
  const message: TranscriptMessage = settled
    ? { role: 'assistant', text, streamKey: key }
    : { role: 'assistant', text, streamKey: key, blocks, open: true }
  return found ? transcript.map((old) => (old === found ? message : old)) : [...transcript, message]
}

/** What an ACP session update does to what was said: text adds to it; thoughts and tool calls close what was written. */
export function updated(transcript: Transcript, update: unknown): Transcript {
  if (!isRecord(update)) return transcript
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': return onChunk(transcript, contentText(update.content))
    case 'viva_stream': return onStream(transcript, update)
    case 'agent_thought_chunk': return contentText(update.content) ? closed(transcript) : transcript
    case 'tool_call':
    case 'tool_call_update': return update.toolCallId ? closed(transcript) : transcript
    default: return transcript
  }
}

/** The turn ended: what was written closes; a turn that said nothing leaves a note saying so, as the window does. */
export function ended(transcript: Transcript, stopReason: unknown): Transcript {
  const done = closed(transcript)
  if (done.at(-1)?.role === 'assistant') return done
  const note = stopReason === 'cancelled' ? t('state.this.turn.was.stopped') : t('state.no.text.response.this.turn')
  return [...done, { role: 'note', text: note }]
}

/** As the history keeps it. */
export const saved = (transcript: Transcript): SavedMessage[] => transcript.map(({ role, text }) => ({ role, text }))

/** A transcript from what the history kept, to go on from. */
export const fromSaved = (messages: ReadonlyArray<{ role?: unknown, text?: unknown }>): Transcript => messages.flatMap((message): TranscriptMessage[] => {
  const { role, text } = message
  return (role === 'user' || role === 'assistant' || role === 'note') && typeof text === 'string' ? [{ role, text }] : []
})
