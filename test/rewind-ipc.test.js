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

function setup({ busy = false, forkResult, traceSteps } = {}) {
  let n = 0
  const db = openHistoryDb({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-')), 'history.db'), newId: () => `c${++n}` })
  let current = db.save(db.create({ sessionId: 's1', cwd: '/w', parentId: null }), [user('做周报'), answer('写好了'), user('太正式了'), answer('改了')])
  const forks = []
  const switches = []
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
    traceDb: () => (traceSteps ? { stepsOf: traceSteps } : null),
    switchAgent: async (sessionId, cwd) => {
      switches.push([sessionId, cwd])
      return { sessionId, cwd, resumed: true, mode: 'live', model: 'V4' }
    },
  })
  const rewind = (request) => handlers['timeline:rewind']({}, request)
  return { db, rewind, forks, switches, handlers, current: () => current }
}

test('going back to a question forks before it and goes on in a new segment; the old path folds there', async () => {
  const { db, rewind, forks, current } = setup()
  const before = current()

  const result = await rewind({ words: '太正式了', occurrence: 0, keep: 2, text: '口语一点' })

  assert.deepEqual(forks, [{ words: '太正式了', occurrence: 0 }])
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.conversation.messages.map((m) => m.text), ['做周报', '写好了'], 'what came before it, for the window')
  assert.deepEqual(result.folds, [{ id: before.id, at: 2, count: 2, kind: 'path' }])
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

test('a folded path can be read, and switched back to: the one on screen folds in its place', async () => {
  const { db, rewind, current, handlers, switches } = setup()
  const first = current()
  await rewind({ words: '太正式了', keep: 2, text: '口语一点' })
  const second = current()

  assert.deepEqual(await handlers['timeline:folded']({}, first.id), { messages: [user('太正式了'), answer('改了')] }, 'what folded, after the shared part')

  const back = await handlers['timeline:switch-path']({}, first.id)
  assert.equal(back.ok, true, JSON.stringify(back))
  assert.deepEqual(switches, [['s1', '/w']], 'the agent goes back to that path’s own session')
  assert.equal(current().id, first.id)
  assert.deepEqual(back.conversation.messages.map((m) => m.text), ['做周报', '写好了', '太正式了', '改了'])
  assert.deepEqual(back.folds, [{ id: second.id, at: 2, count: 1, kind: 'path' }], 'the path just left hangs where they part')
  assert.deepEqual(db.foldsOf(second.id), [])
  assert.equal(db.latest().conversation.id, first.id)

  assert.equal((await handlers['timeline:switch-path']({}, 'nope')).ok, false, 'only a path folded off this one')
})

test('before going back, what the part that would fold did to the computer: its session’s steps from that message on', async () => {
  const steps = []
  const { db, handlers, current } = setup({ traceSteps: (sessionId) => (sessionId === 's1' ? steps : []) })
  const at = db.timelineOf(current().id)[2].at
  steps.push(
    { seq: 1, at: at - 1, kind: 'tool', name: 'write', args: { file_path: '/w/before.md' }, status: 'completed' },
    { seq: 2, at: at + 1, kind: 'tool', name: 'write', args: { file_path: '/w/summary.md' }, status: 'completed' },
    { seq: 3, at: at + 2, kind: 'tool', name: 'bash', args: { command: 'git add summary.md' }, status: 'completed' },
  )

  assert.deepEqual(await handlers['timeline:rewind-effects']({}, { keep: 2 }), {
    files: [{ path: '/w/summary.md', times: 1 }], commands: ['git add summary.md'],
  })
  assert.deepEqual(await handlers['timeline:rewind-effects']({}, { keep: 9 }), { files: [], commands: [] }, 'nothing past the end')
  const blind = setup()
  assert.deepEqual(await blind.handlers['timeline:rewind-effects']({}, { keep: 0 }), { files: [], commands: [] }, 'no trace, nothing to say')
})

test('requests are checked before anything else', async () => {
  const { rewind, forks } = setup()
  for (const bad of [null, { words: '', keep: 0, text: 'x' }, { words: '做周报', keep: -1, text: 'x' }, { words: '做周报', keep: 0, text: '' }, { words: '做周报', keep: 0, text: 'x', occurrence: 1.5 }]) {
    await assert.rejects(rewind(bad), /invalid rewind/)
  }
  assert.deepEqual(forks, [])
})
