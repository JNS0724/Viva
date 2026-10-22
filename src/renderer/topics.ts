/**
 * 话题: the stretch of the one timeline the assistant has in mind. A segment either goes on from the one it
 * continues (its parentId: a change of working directory, or 回到这个话题) or starts a new topic (⌘N, 开新话题).
 * The topic on screen is the conversation now and, back along what each continued, the segments before it;
 * everything else above is still there to read, but the assistant no longer has it.
 */
export const initialTopic = Object.freeze({ parentId: null, startedAt: null, menu: false })
/** From this share of the context on, the label by the input suggests a new topic. */
export const NEAR_FULL = 0.8

/** The earlier segments the conversation on screen goes on from. */
export function rememberedIds(segments: ReadonlyArray<{ id: string, parentId?: string | null }>, parentId: string | null): Set<string> {
  const byId = new Map(segments.map((segment) => [segment.id, segment]))
  const ids = new Set<string>()
  for (let id = parentId; id && byId.has(id) && !ids.has(id); id = byId.get(id)?.parentId ?? null) ids.add(id)
  return ids
}

/** Earlier segments that read as one topic: whether the assistant has them in mind, when it began, how many messages. */
type TopicBlock = { remembered: boolean, segments: readonly Segment[], at: number | null, count: number }

/** The earlier segments as topics, in order: a topic goes on while each segment continues the one before it. */
export function topicBlocks(segments: readonly Segment[], parentId: string | null): TopicBlock[] {
  const remembered = rememberedIds(segments, parentId)
  return segments.reduce((blocks: TopicBlock[], segment, i) => {
    const keep = remembered.has(segment.id)
    const last = blocks.at(-1)
    const continues = i > 0 && segment.parentId === segments[i - 1].id
    if (last && continues && last.remembered === keep) {
      return [...blocks.slice(0, -1), { ...last, segments: [...last.segments, segment], count: last.count + segment.messages.length }]
    }
    return [...blocks, { remembered: keep, segments: [segment], at: segment.messages[0]?.at ?? segment.createdAt ?? null, count: segment.messages.length }]
  }, [])
}

/**
 * Where the topic on screen starts, said at the end of the earlier timeline:
 *   'new': a new topic (undoable while nothing has been said in it);
 *   'back': it goes on from an earlier topic, not the segment just above (回到这个话题);
 *   null: it goes on from the segment just above, or there is nothing above.
 */
export function topicStart(state: State): { kind: 'new', at: number | null, undo: string | null } | { kind: 'back', at: number | null } | null {
  const segments: readonly Segment[] = state.earlier.segments
  const last = segments.at(-1)
  if (!last) return null
  const { parentId, startedAt } = state.topic
  if (!parentId) return { kind: 'new', at: startedAt, undo: state.messages.length === 0 ? last.id : null }
  if (parentId === last.id) return null
  const block = topicBlocks(segments, parentId).find((item) => item.segments.some((segment) => segment.id === parentId))
  return { kind: 'back', at: block?.at ?? null }
}

/** How many messages the assistant has in mind now: the topic's earlier segments and the conversation on screen. */
export function topicCount(state: State) {
  const segments: readonly Segment[] = state.earlier.segments
  const remembered = rememberedIds(segments, state.topic.parentId)
  const earlier = segments.filter((segment) => remembered.has(segment.id)).reduce((sum, segment) => sum + segment.messages.length, 0)
  return earlier + state.messages.length
}

/** The share of the context used, 0–1, once the agent has said. */
export const contextShare = (usage: { used: number, size: number } | null | undefined): number | null => (usage?.size ? Math.min(1, usage.used / usage.size) : null)
