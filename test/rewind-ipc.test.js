import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHistoryDb } from '../src/main/history-db.js'
import { registerRewindIpc } from '../src/main/rewind-ipc.js'

/**
 * Going back to something the user said, from the window (phase 2): the agent forks to before that turn, the
 * timeline goes on in a new segment with what came before it and the new words, and the path left behind folds.
 */

const user = (text) => ({ role: 'user', text, receipt: null })
const answer = (text) => ({ role: 'assistant', text, receipt: null })

function setup({ busy = false, forkResult } = {}) {
  let n = 0
  const db = openHistoryDb({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-')), 'history.db'), newId: () => `c${++n}` })
  let current = db.save(db.create({ sessionId: 's1', cwd: '/w', parentId: null }), [user('做周报'), answer('写好了'), user('太正式了'), answer('改了')])
  const forks = []
  const handlers = {}
  registerRewindIpc({ handle: (channel, fn) => { handlers[channel] = fn } }, {
    db,
    current: () => current,
    setCurrent: (next) => { current = next },
    isBusy: () => busy,
    agentInfo: () => ({ mode: 'live', model: 'V4' }),
    forkAgent: async (request) => {
      forks.push(request)
      return forkResult ?? { ok: true, info: { sessionId: 's2', mode: 'live', model: 'V4', cwd: '/w' } }
    },
  })
  const rewind = (request) => handlers['timeline:rewind']({}, request)
  return { db, rewind, forks, current: () => current }
}

test('going back to a question forks before it and goes on in a new segment; the old path folds there', async () => {
  const { db, rewind, forks, current } = setup()
  const before = current()

  const result = await rewind({ words: '太正式了', occurrence: 0, keep: 2, text: '口语一点' })

  assert.deepEqual(forks, [{ words: '太正式了', occurrence: 0 }])
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.conversation.messages.map((m) => m.text), ['做周报', '写好了'], 'what came before it, for the window')
  assert.deepEqual(result.folds, [{ id: before.id, at: 2, count: 2 }])
  assert.equal(current().id, result.conversation.id)
  assert.equal(current().sessionId, 's2')
  assert.deepEqual(db.get(current().id).messages.map((m) => m.text), ['做周报', '写好了', '口语一点'], 'stored at once, the new words with it')
  assert.deepEqual(db.segmentsBefore(current().id).segments, [], 'the old path is folded, not before it in the timeline')
})

test('nothing moves while the agent works, for words not stored there, or when the agent cannot go back', async () => {
  const busy = setup({ busy: true })
  assert.deepEqual(await busy.rewind({ words: '太正式了', keep: 2, text: 'x' }), { ok: false, problem: '先停止当前任务，再回到前面重来' })

  const other = setup()
  const mismatch = await other.rewind({ words: '没说过', keep: 2, text: 'x' })
  assert.equal(mismatch.ok, false)
  assert.deepEqual(other.forks, [], 'the agent is not asked when the timeline does not have those words there')

  const refused = setup({ forkResult: { ok: false, reason: 'invalid' } })
  const kept = refused.current()
  const result = await refused.rewind({ words: '太正式了', keep: 2, text: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.problem, /找不到/)
  assert.equal(refused.current(), kept, 'the conversation on screen stays')
  assert.deepEqual(refused.db.foldsOf(kept.id), [])
})

test('requests are checked before anything else', async () => {
  const { rewind, forks } = setup()
  for (const bad of [null, { words: '', keep: 0, text: 'x' }, { words: '做周报', keep: -1, text: 'x' }, { words: '做周报', keep: 0, text: '' }, { words: '做周报', keep: 0, text: 'x', occurrence: 1.5 }]) {
    await assert.rejects(rewind(bad), /invalid rewind/)
  }
  assert.deepEqual(forks, [])
})
