/** Provisional blocks belong to one model attempt. Settlement replaces them; a retry removes them. */
type Visible = { type: string, text: string }
export function assistantStream(state: State, update: any, at: number): State {
  const key = update.key as string
  const settled = update.kind === 'settle'
  function change(list: readonly any[], type: string) {
    const found = list.find(item => item.streamKey === key)
    if (!settled && update.blockType !== type) return list
    let blocks: Array<{ index: number, text: string }> = found?.streamBlocks ?? []
    if (settled) {
      blocks = (update.blocks as Visible[]).filter(block => block.type === type && block.text).map((block, index) => ({ index, text: block.text }))
    } else {
      const prior = blocks.find(block => block.index === update.index)
      const block = { index: update.index, text: update.kind === 'block' ? update.text : (prior?.text ?? '') + update.text }
      blocks = prior ? blocks.map(item => item.index === block.index ? block : item) : [...blocks, block]
    }
    const text = blocks.map(block => block.text).join('')
    if (!text) return found ? list.filter(item => item !== found) : list
    const item = { ...found, id: found?.id ?? `stream:${key}:${type}`, streamKey: key, streamBlocks: settled ? undefined : blocks,
      text, open: !settled, shown: text.length, receipt: found?.receipt ?? null, at: found?.at ?? at,
      ...(type === 'text' ? { role: 'assistant' } : {}) }
    return found ? list.map(old => old === found ? item : old) : [...list, item]
  }
  const messages = change(state.messages, 'text')
  const thoughts = change(state.thoughts, 'reasoning')
  const old = state.thoughts.find(item => item.streamKey === key)
  const thought = thoughts.find(item => item.streamKey === key)
  const timeline = old && !thought ? state.timeline.filter(item => !(item.kind === 'thought' && item.ref === old.id))
    : !old && thought ? [...state.timeline, { kind: 'thought', ref: thought.id, at }] : state.timeline
  const delta = Number(Boolean(thought)) - Number(Boolean(old))
  return messages === state.messages && thoughts === state.thoughts ? state : {
    ...state, messages, thoughts, timeline,
    turn: state.turn && delta ? { ...state.turn, thoughts: state.turn.thoughts + delta } : state.turn,
  }
}
