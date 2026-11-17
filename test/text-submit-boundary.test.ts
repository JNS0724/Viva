import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createRewindActions } from '../src/renderer/rewind-actions.ts'
import { withFiles } from '../src/shared/attachments.ts'
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

test('resending the unedited original keeps its text and source, including an attachment-only message', async () => {
  const text = withFiles('', ['/work/brief.md'])
  const sourceId = 'af72d069-b720-41dd-ac02-82ed35cb56d4'
  let state = reduce(initialState, { type: 'history_loaded', conversationId: 'old', messages: [{ role: 'user', text, sourceId, receipt: null }], savedAt: 1 })
  const id = state.messages[0]!.id
  const sent: Array<{ text: string, sourceId?: string, newSource?: boolean }> = []
  const actions = createRewindActions({
    api: {
      rewindEffects: async () => ({ files: [], commands: [] }),
      rewind: async request => {
        assert.deepEqual(request, { words: text, text, occurrence: 0, keep: 0 })
        return { ok: true, conversation: { id: 'next', messages: [] }, info: { sessionId: 'forked' }, folds: [], sourceId }
      },
      switchPath: unexpected,
      foldedPath: unexpected,
    },
    getState: () => state,
    dispatch: action => { state = reduce(state, action) },
    showToast: assert.fail,
    errorMessage: String,
    ask: (words, options) => { sent.push({ text: words, sourceId: options?.sourceId, newSource: options?.newSource }); return true },
  })
  actions.editFrom(id)
  assert.equal(state.rewind.editing, id)
  await actions.submitEdit(id, text)
  assert.equal(state.conversationId, 'next')
  assert.deepEqual(sent, [{ text, sourceId, newSource: undefined }])
})

test('trace erasure closes an existing rewind confirmation and ignores a late effects reply', async () => {
  let state = reduce(initialState, { type: 'history_loaded', conversationId: 'old',
    messages: [{ role: 'user', text: '原问题', receipt: null }], savedAt: 1 })
  const id = state.messages[0]!.id
  state = reduce(state, { type: 'rewind_edit', id })
  const effects = { files: [], commands: ['old command'] }
  state = reduce(state, { type: 'rewind_confirm', id, text: '编辑内容', effects })
  let resolveEffects!: (value: typeof effects) => void
  const pendingEffects = new Promise<typeof effects>(resolve => { resolveEffects = resolve })
  const actions = createRewindActions({
    api: { rewindEffects: () => pendingEffects, rewind: unexpected, switchPath: unexpected, foldedPath: unexpected },
    getState: () => state,
    dispatch: action => { state = reduce(state, action) },
    showToast: () => {},
    errorMessage: String,
    ask: () => { assert.fail('Must not start a new request from obsolete effects') },
  })
  const before = actions.submitEdit(id, '编辑内容')
  state = reduce(state, { type: 'trace_invalidated', currentSession: true })
  assert.equal(state.rewind.confirm, null)
  resolveEffects(effects)
  await before
  await actions.confirmRewind()
  assert.equal(state.rewind.confirm, null)
  assert.equal(state.rewind.editing, id)
})
