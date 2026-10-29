import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createRewindActions } from '../src/renderer/rewind-actions.ts'
import { createTaskActions } from '../src/renderer/task-actions.ts'
import { MAX_MESSAGE_CHARS, MESSAGE_TOO_LONG } from '../src/shared/text-limits.ts'

const unexpected = async (): Promise<never> => { assert.fail('This request must not be called') }

test('an oversized edit leaves its existing path and editor intact without starting a fork', async () => {
  let state = reduce(initialState, { type: 'history_loaded', conversationId: 'old', messages: [{ role: 'user', text: '原问题', receipt: null }], savedAt: 1 })
  const id = state.messages[0]!.id
  state = reduce(state, { type: 'rewind_edit', id })
  const unchanged = state
  let called = false
  const toasts: string[] = []
  const actions = createRewindActions({
    api: { rewindEffects: async () => { called = true; return { files: [], commands: [] } }, rewind: unexpected, switchPath: unexpected, foldedPath: unexpected },
    getState: () => state,
    dispatch: action => { state = reduce(state, action) },
    showToast: text => { toasts.push(text) },
    errorMessage: String,
    ask: () => { called = true; return true },
  })
  await actions.submitEdit(id, '长'.repeat(MAX_MESSAGE_CHARS + 1))
  assert.equal(called, false)
  assert.equal(state, unchanged)
  assert.equal(state.rewind.editing, id)
  assert.deepEqual(toasts, [MESSAGE_TOO_LONG])
})

test('a refused task follow-up signals the input to restore its draft and retains the prior task', async () => {
  let state = reduce(initialState, { type: 'task_started', task: { id: 'task-1', title: '任务', segmentId: 's1' }, text: '原请求', at: 1 })
  state = reduce(state, { type: 'task_end', taskId: 'task-1', stopReason: 'end_turn', at: 2 })
  const before = state.tasks.list[0]
  const toasts: string[] = []
  const actions = createTaskActions({
    api: { askTask: async () => ({ ok: false, problem: '暂时接不上' }), stopTask: unexpected, startTask: unexpected, answerQuestion: unexpected,
      spinOffTask: unexpected, saveTask: unexpected, unfinishedTasks: unexpected, finishedTasks: unexpected, resumeTask: unexpected,
      forgetTask: unexpected, undoTask: unexpected, closeTask: unexpected, steerTask: unexpected },
    getState: () => state,
    dispatch: action => { state = reduce(state, action) },
    showToast: text => { toasts.push(text) },
    errorMessage: String,
    deliver: () => {},
    later: () => {},
  })
  assert.equal(await actions.askTask('task-1', '没有送达的完整草稿'), false)
  assert.equal(state.tasks.list[0], before)
  assert.deepEqual(toasts, ['暂时接不上'])
  assert.equal(await actions.askTask('gone', '另一份草稿'), false)
})
