/**
 * Going back to something the user said (phase 2): which messages can be gone back to, the one being edited,
 * and what is on screen once the agent went back (main/rewind-ipc.js). Pure and immutable like `state.js`,
 * which merges these handlers into its reducer.
 */
export const initialRewind = Object.freeze({
  /** The message being edited in place (改了重发), by id. */
  editing: null as string | null,
  /** The agent is going back; nothing else may be sent until it has. */
  busy: false,
  /** Folded paths opened in place to be read: their messages after the shared part, by path id. */
  open: {} as Record<string, Untyped>,
  /** Going back over changes to the computer waits on the user: { id, text, effects } (main/side-effects.js). */
  confirm: null as Untyped,
})

/** A path folded off the conversation: where it hangs (after that many saved messages), how many it folds, and whether a path or a task. */
export type Fold = { id: string, at: number, count: number, kind: string }

/** Words that started a turn of their own: not said into a running one, not an answer, not left unsent. */
const startsTurn = (message: ThreadMessage) => message.role === 'user' && !message.open && !message.steered && !message.asked && !message.failed

/** View eligibility is constant time; locating the turn is needed only when the user invokes it. */
export const canRewindMessage = (state: State, message: ThreadMessage) => state.phase === 'idle'
  && Boolean(state.conversationId) && !state.rewind.busy && startsTurn(message)

/**
 * Where to go back to for the message `id`: its words, which such turn from the end (dsh finds the turn by them,
 * plugins/fork), and how many saved messages come before it (selectors.js historyMessages keeps the finished ones).
 * @returns null when it cannot be gone back to now
 */
export function rewindTarget(state: State, id: string): { words: string, occurrence: number, keep: number } | null {
  if (state.phase !== 'idle' || !state.conversationId || state.rewind.busy) return null
  const saved = state.messages.filter((message) => !message.open)
  const keep = saved.findIndex((message) => message.id === id)
  const message = saved[keep]
  if (!message || !startsTurn(message)) return null
  const occurrence = saved.slice(keep + 1).filter((later) => later.role === 'user' && later.text === message.text).length
  return { words: message.text, occurrence, keep }
}

/**
 * The folded paths by the message they hang after (its id; '' before everything): a fold at `at` follows the
 * `at`-th saved message.
 */
export function foldAfter(state: State): Record<string, Fold[]> {
  const saved = state.messages.filter((message) => !message.open)
  return state.folds.reduce((byMessage: Record<string, Fold[]>, fold: Fold) => {
    const key = fold.at === 0 ? '' : saved[fold.at - 1]?.id
    return key === undefined ? byMessage : { ...byMessage, [key]: [...(byMessage[key] ?? []), fold] }
  }, {})
}

const withRewind = (state: State, changes: Partial<State['rewind']>): State => ({ ...state, rewind: { ...state.rewind, ...changes } })

/** @param newSession state.ts's new_session, for the reset */
export function rewindActions(newSession: Reducer): Record<string, Reducer> {
  return {
    rewind_edit: (state, { id }) => withRewind(state, { editing: id }),
    rewind_cancel: (state) => withRewind(state, { editing: null }),
    rewind_busy: (state) => withRewind(state, { busy: true, confirm: null }),
    rewind_confirm: (state, { id, text, effects }) => withRewind(state, { confirm: { id, text, effects } }),
    rewind_confirm_cancel: (state) => withRewind(state, { confirm: null }),
    rewind_failed: (state) => withRewind(state, { busy: false }),
    fold_opened: (state, { id, messages }) => withRewind(state, { open: { ...state.rewind.open, [id]: messages } }),
    fold_closed: (state, { id }) => withRewind(state, {
      open: Object.fromEntries(Object.entries(state.rewind.open).filter(([key]) => key !== id)),
    }),
    /**
     * The agent went back: on screen are what came before that point, as it was, and the path left behind,
     * folded after it. The earlier timeline stays; the new words follow as the next question.
     */
    rewound: (state, { conversation, info, folds }) => ({
      ...newSession(state, { info: { ...state.info, ...info, remembersHistory: true } }),
      earlier: state.earlier,
      // Going back is within the topic.
      topic: state.topic,
      conversationId: conversation.id,
      messages: conversation.messages.map((m: SegmentMessage, i: number) => ({
        id: `m${i}`, role: m.role, text: m.text, shown: m.text.length, open: false, receipt: m.receipt ?? null, ...(m.images ? { images: m.images } : {}),
      })),
      folds,
    }),
  }
}
