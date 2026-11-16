import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createHistoryActions } from '../src/renderer/history-actions.ts'
import { hitTarget } from '../src/renderer/timeline-search.ts'

/** 详情 on a search hit, or a link in an answer: on screen only once the history has found that very message. */

type Located = { status: string, segmentId: string, seq?: number | null, messageId?: number }

function setup(state: State, locate: (hit: SearchHit) => Promise<Located>, loadTrace?: AgentApi['loadTrace']) {
  let current = state
  const revealed: string[] = []
  const reviewed: SearchHit[] = []
  const actions = createHistoryActions({
    api: { loadTrace } as AgentApi,
    getState: () => current,
    dispatch: (action) => { current = reduce(current, action) },
    searchField: { focus() {}, select() {} } as HTMLInputElement,
    errorMessage: (err) => String(err),
    locate,
    revealOnScreen: (found) => {
      const target = hitTarget(current, found)
      return target ? () => { revealed.push(target.msgId) } : null
    },
    openInReview: async (hit) => { reviewed.push(hit) },
  })
  return { actions, revealed, reviewed, state: () => current }
}

const onScreen = (): State => ({
  ...initialState,
  conversationId: 'now',
  messages: [{ id: 'm1', role: 'user', text: '写首诗' }, { id: 'm2', role: 'assistant', text: '床前明月光' }],
} as State)

test('a message the history found at its place in the conversation on screen is scrolled to there', async () => {
  const { actions, revealed, reviewed } = setup(onScreen(), async () => ({ status: 'found', segmentId: 'now', seq: 1, messageId: 7 }))
  await actions.jumpToHit({ segmentId: 'now', seq: 1, messageId: 7 })
  assert.deepEqual([revealed, reviewed], [['m2'], []])
})

test('a message said again differently since is not taken for what is at its place: 回顾 says it is gone', async () => {
  const { actions, revealed, reviewed, state } = setup(onScreen(), async () => ({ status: 'missing', segmentId: 'now', seq: 1 }))
  await actions.jumpToHit({ segmentId: 'now', seq: 1, messageId: 7 })
  assert.deepEqual(revealed, [], 'the new message at that place is not marked')
  assert.deepEqual(reviewed, [{ segmentId: 'now', seq: 1, messageId: 7 }])
  assert.equal(state().history.open, true)
})

test('when the history does not answer, nothing on screen is guessed at; 回顾 reports it with 重试', async () => {
  const { actions, revealed, reviewed } = setup(onScreen(), async () => { throw new Error('database is locked') })
  await actions.jumpToHit({ segmentId: 'now', seq: 1 })
  assert.deepEqual([revealed, reviewed.length], [[], 1])
})


test('trace refresh rejects a pre-erasure reply and retries once the agent becomes ready', async () => {
  type Response = Awaited<ReturnType<AgentApi['loadTrace']>>
  let resolveDelayed!: (result: Response) => void
  const delayed = new Promise<Response>(resolve => { resolveDelayed = resolve })
  const seen: Array<number | undefined> = []
  const noTrace = { thoughts: [], tools: {}, timeline: [] }
  const oldTrace = { ...noTrace, thoughts: [{ id: 'old', text: 'erased reasoning', open: false, at: 2 }] }
  const { actions, state } = setup({ ...onScreen(), restored: { count: 2, savedAt: 10 }, restoredTrace: 'loading' },
    async () => ({ status: 'missing', segmentId: 'now' }), async (_id, until) => {
      seen.push(until)
      if (seen.length === 1) return delayed
      return { trace: noTrace, available: seen.length > 2, missing: 0 }
    })
  const pending = actions.loadTrace('now')
  await actions.invalidateTrace(['earlier-session'])
  resolveDelayed({ trace: oldTrace, available: true, missing: 0 })
  await pending
  assert.equal(state().restoredTrace, 'unavailable')
  assert.deepEqual(state().thoughts, [])
  await actions.retryTrace()
  assert.equal(state().restoredTrace, 'loaded')
  await actions.retryTrace()
  assert.deepEqual(seen, [10, 10, 10])
})
