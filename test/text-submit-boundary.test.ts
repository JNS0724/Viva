import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createRewindActions } from '../src/renderer/rewind-actions.ts'
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

