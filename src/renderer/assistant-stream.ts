import type { StreamText, VivaStreamUpdate, ConversationTrace } from './conversation-types.ts'

/** Provisional blocks belong to one model attempt. Settlement replaces them; a retry removes them. */
export function assistantStream(state: ConversationView, update: VivaStreamUpdate, at: number): ConversationView {
  const key = update.key, settled = update.kind === 'settle'
  function change<T extends StreamText>(list: readonly T[], type: string, make: (base: StreamText, prior: T | undefined) => T): readonly T[] {
    const found = list.find(item => item.streamKey === key)
    if (update.kind !== 'settle' && update.blockType !== type) return list
    let blocks = found?.streamBlocks ?? []
    if (update.kind === 'settle') {
      blocks = update.blocks.flatMap((block, index) => block.type === type && block.text ? [{ index, text: block.text }] : [])
    } else {
      const prior = blocks.find(block => block.index === update.index)
      const block = { index: update.index, text: update.kind === 'block' ? update.text : (prior?.text ?? '') + update.text }
      blocks = prior ? blocks.map(item => item.index === block.index ? block : item) : [...blocks, block]
    }
    const text = blocks.map(block => block.text).join('')
    if (!text) return found ? list.filter(item => item !== found) : list
    const item = make({ id: found?.id ?? `stream:${key}:${type}`, streamKey: key, streamBlocks: settled ? undefined : blocks,
      text, open: !settled, at: found?.at ?? at }, found)
    if (found) return list.map(old => old === found ? item : old)
    const before = update.kind === 'settle' ? update.before?.[type as 'text' | 'reasoning'] : undefined
    const position = before === undefined ? -1 : list.findIndex(old => old.streamKey === before)
    return position < 0 ? [...list, item] : [...list.slice(0, position), item, ...list.slice(position)]
  }
  const messages = change(state.messages, 'text', (base, prior) => ({ ...prior, ...base, role: 'assistant', shown: base.text.length, receipt: prior?.receipt ?? null }))
  const thoughts = change(state.thoughts, 'reasoning', (base, prior) => ({ ...prior, ...base }))
  const old = state.thoughts.find(item => item.streamKey === key), thought = thoughts.find(item => item.streamKey === key)
  const timeline: readonly ConversationTrace[] = old && !thought ? state.timeline.filter(item => !(item.kind === 'thought' && item.ref === old.id))
    : !old && thought ? [...state.timeline, { kind: 'thought', ref: thought.id, at }] : state.timeline
  const delta = Number(Boolean(thought)) - Number(Boolean(old))
  return messages === state.messages && thoughts === state.thoughts ? state : {
    ...state, messages, thoughts, timeline,
    turn: state.turn && delta ? { ...state.turn, thoughts: state.turn.thoughts + delta } : state.turn,
  }
}
