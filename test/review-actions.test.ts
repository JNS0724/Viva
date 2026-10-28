import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createReviewActions } from '../src/renderer/review-actions.ts'

/** A message named by a search hit, a link or a star, read in 回顾 straight from where it is kept. */

type Api = Parameters<typeof createReviewActions>[0]['api']
const message = (segmentId: string, seq: number, text: string) => ({ id: seq + 1, seq, role: seq % 2 ? 'assistant' : 'user', text, receipt: null, at: 1, segmentId })

function setup(api: Partial<Api>) {
  let state: State = initialState
  const toasts: Array<{ text: string, action?: ToastAction | null }> = []
  const revealed: string[] = []
  const actions = createReviewActions({
    api: api as Api,
    getState: () => state,
    dispatch: (action) => { state = reduce(state, action) },
    errorMessage: (err) => (err instanceof Error ? err.message : String(err)),
    showToast: (text, options) => { toasts.push({ text, action: options?.action }) },
    reveal: (msgId) => { revealed.push(msgId); return true },
  })
  return { actions, toasts, revealed, state: () => state }
}

const topicRead = {
  topic: { id: 't1', title: '审一下合同', startedAt: 5, lastAt: 9, turns: 2, hasFiles: false, stars: 0, cwds: [], segments: ['a'], head: 'a', tasks: [] },
  messages: [message('a', 0, '审一下合同'), message('a', 1, '好')],
}

test('a message found is read in its topic at the top and marked, with 继续 going on from the topic', async () => {
  const asked: unknown[] = []
  const { actions, revealed, state } = setup({
    locateMessage: async (ref) => { asked.push(ref); return { status: 'found', segmentId: 'a', seq: 1, messageId: 2, reader: { key: 't:t1', topicId: 't1' } } },
    topicMessages: async () => topicRead,
  })
  await actions.openRef({ segmentId: 'a', seq: 1, messageId: 2 })
  assert.deepEqual(asked, [{ segmentId: 'a', seq: 1, messageId: 2 }])
  assert.deepEqual(state().review.focus, { key: 't:t1', title: '审一下合同', at: 5, head: 'a', found: 'a-1', notice: null })
  assert.equal(state().review.reading?.messages.length, 2)
  assert.deepEqual(revealed, ['a-1'])
})

test('a message no longer there shows the messages near where it was, said so, none marked', async () => {
  const { actions, revealed, state } = setup({
    locateMessage: async () => ({ status: 'missing', segmentId: 'a', seq: 1, reader: { key: 't:t1', topicId: 't1' } }),
    topicMessages: async () => topicRead,
  })
  await actions.openRef({ segmentId: 'a', seq: 3, messageId: 9 })
  assert.match(state().review.focus?.notice ?? '', /原文已经不在了/)
  assert.equal(state().review.focus?.found, null, 'none marked as the one found')
  assert.deepEqual(revealed, ['a-1'])
})

test('a deleted record says so; a read that failed says that apart, with 重试', async () => {
  const deleted = setup({ locateMessage: async () => ({ status: 'deleted', segmentId: 'a', reader: null }) })
  await deleted.actions.openRef({ segmentId: 'a', seq: 0 })
  assert.deepEqual(deleted.toasts.map((t) => t.text), ['这条记录已经删除了'])
  assert.equal(deleted.state().review.focus, null)

  const failed = setup({ locateMessage: async () => { throw new Error('database is locked') } })
  await failed.actions.openRef({ segmentId: 'a', seq: 0 })
  assert.match(failed.toasts[0].text, /读取失败：database is locked/)
  assert.deepEqual(failed.toasts[0].action, { label: '重试', kind: 'open-ref', payload: { segmentId: 'a', seq: 0 } })
})

test('a star on the talk a moved turn shares is found by reading that segment whole', async () => {
  const wholes: boolean[] = []
  const { actions, revealed } = setup({
    locateMessage: async () => ({ status: 'found', segmentId: 'moved', seq: 0, messageId: 1, reader: { key: 's:moved', topicId: 't1' } }),
    segmentMessages: async (_id, whole) => {
      wholes.push(Boolean(whole))
      return { messages: whole ? [message('moved', 0, '报销'), message('moved', 2, '周报')] : [message('moved', 2, '周报')] }
    },
  })
  await actions.openRef({ segmentId: 'moved', seq: 0 })
  assert.deepEqual(wholes, [false, true])
  assert.deepEqual(revealed, ['moved-0'])
})

test('another filter reads the topics again for it; 收藏 reads the stars', async () => {
  const filters: unknown[] = []
  let starred = 0
  const { actions } = setup({
    reviewTimeline: async (after, filter) => { filters.push([after, filter]); return { topics: [], hasMore: false } },
    starredMessages: async () => { starred += 1; return [] },
  })
  actions.reviewFilter('tasks')
  actions.reviewFilter('stars')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(filters, [[null, 'tasks']])
  assert.equal(starred, 1)
})
