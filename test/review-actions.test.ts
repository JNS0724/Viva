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
  total: 2, from: 0,
  messages: [message('a', 0, '审一下合同'), message('a', 1, '好')],
}

test('a message found is read in its topic at the top, the part around it, and marked, with 继续 going on from the topic', async () => {
  const asked: unknown[] = []
  const reads: unknown[] = []
  const { actions, revealed, state } = setup({
    locateMessage: async (ref) => { asked.push(ref); return { status: 'found', segmentId: 'a', seq: 1, messageId: 2, reader: { key: 't:t1', topicId: 't1' } } },
    readHistory: async (key, request) => { reads.push([key, request]); return topicRead },
  })
  await actions.openRef({ segmentId: 'a', seq: 1, messageId: 2 })
  assert.deepEqual(asked, [{ segmentId: 'a', seq: 1, messageId: 2 }])
  assert.deepEqual(reads, [['t:t1', { around: { segmentId: 'a', seq: 1 } }]])
  assert.deepEqual(state().review.focus, { key: 't:t1', title: '审一下合同', at: 5, head: 'a', found: 'a-1', notice: null })
  assert.equal(state().review.reading?.messages.length, 2)
  assert.deepEqual(revealed, ['a-1'])
})

test('a message no longer there shows the messages near where it was, said so, none marked', async () => {
  const { actions, revealed, state } = setup({
    locateMessage: async () => ({ status: 'missing', segmentId: 'a', seq: 1, reader: { key: 't:t1', topicId: 't1' } }),
    readHistory: async () => topicRead,
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
    readHistory: async (_key, request) => {
      wholes.push(Boolean(request?.whole))
      const messages = request?.whole ? [message('moved', 0, '报销'), message('moved', 2, '周报')] : [message('moved', 2, '周报')]
      return { topic: null, total: messages.length, from: 0, messages }
    },
  })
  await actions.openRef({ segmentId: 'moved', seq: 0 })
  assert.deepEqual(wholes, [false, true])
  assert.deepEqual(revealed, ['moved-0'])
})

test('a long topic is read on at either end as the user comes to it, the place looked at kept', async () => {
  const total = 1000
  const part = (from: number, count: number) => ({ topic: topicRead.topic, total, from, messages: Array.from({ length: count }, (_, i) => message('a', from + i, `第 ${from + i} 条`)) })
  const asked: unknown[] = []
  let kept = 0
  let state: State = initialState
  const actions = createReviewActions({
    api: {
      readHistory: async (_key, request) => { asked.push(request); return request?.around ? part(450, 100) : part(request?.from ?? 0, request?.count ?? 100) },
      locateMessage: async () => ({ status: 'found', segmentId: 'a', seq: 500, messageId: 501, reader: { key: 't:t1', topicId: 't1' } }),
    } as Partial<Api> as Api,
    getState: () => state, dispatch: (action) => { state = reduce(state, action) }, errorMessage: String,
    showToast: () => {}, reveal: () => true, keepPlace: (change) => { kept += 1; change() },
  })
  await actions.openRef({ segmentId: 'a', seq: 500 })
  await actions.readerMore('before')
  for (let i = 0; i < 3; i += 1) await actions.readerMore('after')
  assert.deepEqual(asked.slice(1), [{ from: 420, count: 30 }, { from: 550, count: 30 }, { from: 580, count: 30 }, { from: 610, count: 30 }])
  const reading = state.review.reading!
  assert.equal(reading.messages.length, 200, 'never more than 200 drawn')
  assert.deepEqual([reading.from, reading.messages[0].seq, reading.messages.at(-1)!.seq], [440, 440, 639])
  assert.equal(kept, 4)
})

/** A topic of `total` messages read from a fake history: parts by place or around a message, each answer held until let go. */
function slowHistory(total: number) {
  const pending: Array<{ request: Record<string, any>, answer: () => void }> = []
  const part = (from: number, count: number) => ({ topic: topicRead.topic, total, from, messages: Array.from({ length: count }, (_, i) => message('a', from + i, `第 ${from + i} 条`)) })
  const readHistory = (_key: string, request: Record<string, any> = {}) => new Promise((resolve) => {
    const from = request.around ? Math.max(0, request.around.seq - 50) : request.from ?? 0
    pending.push({ request, answer: () => resolve(part(from, Math.min(request.count ?? 100, total - from))) })
  })
  return { pending, readHistory }
}

test('a part asked for before the same topic was opened again at another message is not taken into the new reading', async () => {
  const history = slowHistory(2000)
  let at = 500
  let state: State = initialState
  const actions = createReviewActions({
    api: { readHistory: history.readHistory, locateMessage: async () => ({ status: 'found', segmentId: 'a', seq: at, messageId: at + 1, reader: { key: 't:t1', topicId: 't1' } }) } as Partial<Api> as Api,
    getState: () => state, dispatch: (action) => { state = reduce(state, action) }, errorMessage: String, showToast: () => {}, reveal: () => true,
  })
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  const opening = actions.openRef({ segmentId: 'a', seq: 500 })
  await settle()
  history.pending.shift()!.answer()
  await opening
  const stale = actions.readerMore('before')
  await settle()
  const old = history.pending.shift()!
  at = 1500
  const reopening = actions.openRef({ segmentId: 'a', seq: 1500 })
  await settle()
  history.pending.shift()!.answer()
  await reopening
  old.answer()
  await stale

  const reading = state.review.reading!
  assert.deepEqual([reading.from, reading.messages[0].seq, reading.messages.length], [1450, 1450, 100], 'the late part of the old reading is dropped')
})

test('a segment read whole (a star on the talk a moved turn shares) goes on whole as it is read on', async () => {
  const asked: Array<Record<string, any>> = []
  let state: State = initialState
  const whole = (from: number, count: number) => ({ topic: null, total: 400, from, messages: Array.from({ length: count }, (_, i) => message('moved', from + i, `第 ${from + i} 条`)) })
  const actions = createReviewActions({
    api: {
      locateMessage: async () => ({ status: 'found', segmentId: 'moved', seq: 10, messageId: 11, reader: { key: 's:moved', topicId: 't1' } }),
      readHistory: async (_key, request) => {
        asked.push(request ?? {})
        if (!request?.whole) return { topic: null, total: 200, from: 0, messages: [message('moved', 200, '周报')] }
        return request.around ? whole(0, 100) : whole(request.from ?? 0, request.count ?? 100)
      },
    } as Partial<Api> as Api,
    getState: () => state, dispatch: (action) => { state = reduce(state, action) }, errorMessage: String, showToast: () => {}, reveal: () => true,
  })
  await actions.openRef({ segmentId: 'moved', seq: 10 })
  await actions.readerMore('after')
  assert.deepEqual(asked.at(-1), { from: 100, count: 30, whole: true })
  const reading = state.review.reading!
  assert.deepEqual([reading.total, reading.messages.at(-1)!.seq, reading.messages.length], [400, 129, 130], 'goes on from 100, not from where the own part starts')
})

test('switching filters while a list is on its way shows only the list for the filter chosen last', async () => {
  const answers: Array<{ filter: string, answer: (page: { topics: unknown[], hasMore: boolean }) => void }> = []
  const { actions, state } = setup({
    reviewTimeline: (_after, filter) => new Promise((resolve) => { answers.push({ filter: String(filter), answer: resolve }) }),
  })
  const topic = (id: string) => ({ id, title: id, startedAt: 1, lastAt: 1, turns: 1, hasFiles: false, stars: 0, cwds: [], segments: [id], head: id, tasks: [] })

  actions.refreshReview()
  actions.reviewFilter('files')
  assert.deepEqual(answers.map((a) => a.filter), ['all', 'files'], 'the filter chosen is asked for even while 全部 is on its way')
  answers[1].answer({ topics: [topic('with-file')], hasMore: false })
  await new Promise((resolve) => setImmediate(resolve))
  answers[0].answer({ topics: [topic('everything'), topic('else')], hasMore: true })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(state().review.filter, 'files')
  assert.deepEqual(state().review.topics.map((t) => t.id), ['with-file'], 'the late 全部 answer is dropped')
  assert.deepEqual([state().review.hasMore, state().review.loading], [false, false])
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
