import assert from 'node:assert/strict'
import { test } from 'node:test'
import { initialState, reduce } from '../src/renderer/state.ts'
import { contextShare, rememberedIds, topicBlocks, topicCount, topicStart, topicTitle, turnsOf } from '../src/renderer/topics.ts'
import { reachedRecentEnd, RECENT_DAYS } from '../src/renderer/earlier-state.ts'

test('a folded topic is named by its first question, on one line, without the files named after it', () => {
  const ask = (text) => ({ role: 'user', text })
  assert.equal(topicTitle([{ role: 'note', text: '换了目录' }, ask('  把这周的\n进展整理一下 '), ask('再加上计划')]), '把这周的 进展整理一下')
  assert.equal(topicTitle([ask('看看这个\n\n附带的文件（本机路径）：\n- /tmp/a.pdf')]), '看看这个')
  assert.equal(topicTitle([ask('')]), '（图片或文件）')
  assert.equal(topicTitle([]), '（没有提问）')
  assert.equal(topicTitle([ask('问'.repeat(50))]), `${'问'.repeat(40)}…`)
  assert.equal(turnsOf([ask('一'), { role: 'assistant', text: '答' }, ask('二')]), 2)
})

test('scrolling up stops reading back once the oldest part read is older than the recent days', () => {
  const now = Date.UTC(2026, 9, 27, 12)
  const day = 86_400_000
  const read = (at) => ({ segments: [{ id: 'a', createdAt: at, messages: [{ seq: 0, at }] }], hasMore: true, loading: false })
  assert.equal(reachedRecentEnd({ segments: [], hasMore: true, loading: false }, now), false)
  assert.equal(reachedRecentEnd(read(now - (RECENT_DAYS - 1) * day), now), false)
  assert.equal(reachedRecentEnd(read(now - (RECENT_DAYS + 1) * day), now), true)
})

/** 话题: what the assistant has in mind, told apart from the rest of the one timeline. */

const at = (minutes) => Date.UTC(2026, 9, 22, 9, 0) + minutes * 60_000
const segment = (id, parentId, count, start) => ({
  id, parentId, cwd: '/w', createdAt: at(start), messages: Array.from({ length: count }, (_, seq) => ({ seq, role: 'user', text: `${id}${seq}`, at: at(start + seq) })),
})
// a: a topic; b goes on from a (another folder); c: a new topic; d goes on from c.
const SEGMENTS = [segment('a', null, 2, 0), segment('b', 'a', 2, 10), segment('c', null, 3, 20), segment('d', 'c', 1, 30)]
const withTimeline = (topic, messages = []) => ({ ...initialState, earlier: { segments: SEGMENTS, hasMore: false, loading: false }, topic: { ...initialState.topic, ...topic }, messages })

test('what the assistant has in mind: the segment the conversation goes on from, and back along what that went on from', () => {
  assert.deepEqual([...rememberedIds(SEGMENTS, 'd')], ['d', 'c'])
  assert.deepEqual([...rememberedIds(SEGMENTS, 'b')], ['b', 'a'])
  assert.deepEqual([...rememberedIds(SEGMENTS, null)], [])
})

test('earlier segments group into topics; the one the conversation goes on from is remembered', () => {
  const blocks = topicBlocks(SEGMENTS, 'd')
  assert.deepEqual(blocks.map((block) => [block.segments.map((s) => s.id).join(''), block.remembered, block.count]), [['ab', false, 4], ['cd', true, 4]])
  assert.equal(blocks[0].at, at(0), 'a topic is dated by its first message')
  const fresh = topicBlocks(SEGMENTS, null)
  assert.deepEqual(fresh.map((block) => block.remembered), [false, false], 'after a new topic, nothing above is remembered')
})

test('a new topic says where it starts, and can be undone until something is said', () => {
  assert.deepEqual(topicStart(withTimeline({ parentId: null, startedAt: at(40) })), { kind: 'new', at: at(40), undo: 'd' })
  const said = withTimeline({ parentId: null, startedAt: at(40) }, [{ id: 'm0', role: 'user', text: '你好' }])
  assert.equal(topicStart(said).undo, null)
})

test('going on from the segment just above says nothing; going back to an older topic says which', () => {
  assert.equal(topicStart(withTimeline({ parentId: 'd' })), null)
  assert.deepEqual(topicStart(withTimeline({ parentId: 'b' })), { kind: 'back', at: at(0) })
  assert.equal(topicStart({ ...initialState }), null, 'nothing above: nothing to say')
})

test('the label counts the topic\'s earlier messages and the ones on screen; the share once the agent said it', () => {
  assert.equal(topicCount(withTimeline({ parentId: 'd' }, [{ id: 'm0' }, { id: 'm1' }])), 6)
  assert.equal(topicCount(withTimeline({ parentId: null })), 0)
  assert.equal(contextShare(null), null)
  assert.equal(contextShare({ used: 86, size: 100 }), 0.86)
  assert.equal(contextShare({ used: 120, size: 100 }), 1)
})

test('a new topic, a change of folder and going back each set where the topic on screen goes on from', () => {
  const said = { ...initialState, conversationId: 'c1', messages: [{ id: 'm0', role: 'user', text: '周报', open: false, receipt: null }] }
  const fresh = reduce(said, { type: 'new_session', info: initialState.info, at: 5 })
  assert.deepEqual([fresh.topic.parentId, fresh.topic.startedAt], [null, 5])
  assert.equal(fresh.earlier.segments.at(-1).parentId, null, 'the topic left behind keeps what it went on from')

  const moved = reduce(said, { type: 'workdir_switched', info: initialState.info })
  assert.equal(moved.topic.parentId, 'c1', 'a change of folder goes on from the conversation before')

  const back = reduce(fresh, { type: 'topic_resumed', info: initialState.info, parentId: 'c1', at: 9 })
  assert.deepEqual([back.topic.parentId, back.topic.startedAt], ['c1', 9])

  const opened = reduce(initialState, { type: 'history_loaded', conversationId: 'c2', messages: [{ role: 'user', text: 'x' }], parentId: 'c1', createdAt: 3 })
  assert.deepEqual([opened.topic.parentId, opened.topic.startedAt], ['c1', 3])

  const menu = reduce(initialState, { type: 'topic_menu', open: true })
  assert.equal(menu.topic.menu, true)
  assert.equal(reduce(menu, { type: 'new_session', info: initialState.info }).topic.menu, false)
})
