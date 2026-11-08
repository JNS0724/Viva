import test from 'node:test'
import assert from 'node:assert/strict'
import { createComposerDraftStore, type DraftSnapshot } from '../src/shared/composer-draft.ts'
import { createComposerDraftActions } from '../src/renderer/composer-draft-actions.ts'
import { draftTarget } from '../src/renderer/draft-target.ts'
import { createResumeActions } from '../src/renderer/resume-actions.ts'
import { initialState, reduce } from '../src/renderer/state.ts'

const edit = (draft: DraftSnapshot, text: string): DraftSnapshot => ({ ...draft, text, sequence: draft.sequence + 1, baseImages: draft.images.map(image => image.id) })
const image = { id: `${'a'.repeat(64)}.png`, size: 128 }
const file = { path: 'C:\\work\\notes.txt', name: 'notes.txt', size: 10 }

test('drafts survive host handoff with files, images and errors; old hosts cannot overwrite them', () => {
  const store = createComposerDraftStore()
  const first = { ...edit(store.select('topic-a'), '草稿'), files: [file], images: [image], error: 'offline' }
  assert.equal(store.update('main', first).ok, true)
  const desktop = store.own('desk')
  assert.deepEqual([desktop.text, desktop.files, desktop.images, desktop.error], ['草稿', [file], [image], 'offline'])
  assert.equal(store.update('main', edit(first, 'late main')).ok, false)
  assert.equal(store.update('desk', edit(desktop, 'continued')).ok, true)
  const main = store.own('main')
  assert.equal(main.text, 'continued')
  assert.equal(store.update('desk', edit(desktop, 'late island')).ok, false)
  store.select('topic-b')
  assert.equal(store.snapshot().text, '')
  assert.equal(store.select('topic-a').text, 'continued')
})

test('an accepted send receipt cannot clear new typing, another topic, or caller-owned arrays', () => {
  const store = createComposerDraftStore()
  store.update('main', { ...edit(store.snapshot(), 'sent'), files: [file] })
  const sent = store.snapshot()
  const next = edit(sent, 'new typing')
  store.update('main', next)
  next.files.length = 0
  assert.equal(store.clear(sent), false)
  assert.equal(store.snapshot().text, 'new typing')
  assert.equal(store.snapshot().files.length, 1)
  const latest = store.snapshot()
  store.select('another')
  assert.equal(store.clear(latest), true)
  assert.equal(store.select(latest.key).text, '')
})

test('a late image cannot overwrite current text or be erased by an edit based on an older snapshot', () => {
  const store = createComposerDraftStore()
  const base = store.snapshot()
  store.appendImage(base.key, image)
  assert.equal(store.update('main', edit(base, 'current text')).ok, true)
  assert.deepEqual(store.snapshot().images, [image])
  const next = store.snapshot()
  assert.equal(store.update('main', { ...edit(next, next.text), images: [] }).ok, true)
  assert.deepEqual(store.snapshot().images, [], 'explicit removal is preserved')
})

test('late acknowledgements preserve newer local typing while independent images join the shared draft', async () => {
  let receive: (draft: DraftSnapshot) => void = () => {}
  const notifications: DraftSnapshot[] = []
  const writes: DraftSnapshot[] = []
  const store = createComposerDraftStore(draft => notifications.push(draft))
  let local = { text: '', files: [], images: [], error: null } as Pick<DraftSnapshot, 'text' | 'files' | 'images' | 'error'>
  const actions = createComposerDraftActions({ host: 'main', api: {
    getDraft: async () => store.snapshot(), onDraft: callback => { receive = callback; return () => {} },
    updateDraft: draft => { writes.push(draft) }, appendDraftImage: async (key, next) => { store.appendImage(key, next) },
    appendDraftFiles: async () => {},
  }, read: () => local, write: draft => { local = draft } })
  await Promise.resolve()
  local = { ...local, text: 'first' }; actions.changed()
  local = { ...local, text: 'newer typing' }; actions.changed()
  store.appendImage('startup', image)
  for (const draft of writes) store.update('main', draft)
  for (const draft of notifications) receive(draft)
  assert.equal(local.text, 'newer typing')
  assert.deepEqual(local.images, [image])
  assert.equal(store.snapshot().text, 'newer typing')
})

test('a draft snapshot arriving before its target view is applied when that target becomes current', async () => {
  let receive: (draft: DraftSnapshot) => void = () => {}
  const store = createComposerDraftStore(next => receive(next))
  store.select('first')
  let local = { text: '', files: [], images: [], error: null } as Pick<DraftSnapshot, 'text' | 'files' | 'images' | 'error'>
  const actions = createComposerDraftActions({ host: 'main', api: {
    getDraft: async () => store.snapshot(), onDraft: callback => { receive = callback; return () => {} },
    updateDraft: next => { store.update('main', next) }, appendDraftImage: async () => {}, appendDraftFiles: async () => {},
  }, read: () => local, write: next => { local = next } })
  actions.expect('first'); await Promise.resolve()
  local = { ...local, text: 'belongs to first' }; actions.changed()
  store.select('second')
  assert.equal(local.text, 'belongs to first')
  actions.expect('second')
  assert.equal(local.text, '')
  actions.changed()
  assert.equal(store.snapshot().text, '', 'the previous field value never leaks into the next topic')
})

test('explicitly starting a new topic carries the prepared draft, while resuming an existing topic keeps its own', () => {
  const store = createComposerDraftStore()
  store.update('main', { ...edit(store.select('old'), 'typing during preparation'), files: [file], images: [image] })
  const preparing = store.select('new', true)
  assert.equal(preparing.text, 'typing during preparation')
  assert.deepEqual(preparing.files, [file])
  assert.deepEqual(preparing.images, [image])
  store.update('main', edit(preparing, 'new topic edit'))
  assert.equal(store.select('old', true).text, 'typing during preparation', 'an existing draft is never replaced by inherited content')
})

test('normal topic resume restores its draft across continuation segments and renderer reload', async () => {
  const store = createComposerDraftStore()
  const infoA = { mode: 'live', cwd: '/work', model: 'local', topicId: 'topic-a', conversationId: 'segment-a', sessionId: 'session-a' }
  let state = reduce(initialState, { type: 'new_session', info: infoA, at: 1000 })
  const first = store.select(draftTarget(state).key)
  store.update('main', { ...edit(first, 'A draft'), files: [file], images: [image], error: 'A error' })
  state = reduce(state, { type: 'new_session', info: { ...infoA, topicId: 'topic-b', conversationId: 'segment-b' }, at: 2000 })
  store.select(draftTarget(state).key)
  let continuation = 0
  const resume = createResumeActions({
    api: {
      resumeCheck: async () => ({ exists: true, same: true, cwd: '/work' }),
      resumeTopic: async parentId => ({ ok: true, parentId, info: { ...infoA, conversationId: `continued-a-${++continuation}` } }),
      continueFromRecords: async parentId => ({ parentId, turns: 2, info: { ...infoA, sessionId: 'replacement-session', conversationId: 'carried-a' } }),
      chooseWorkDir: async () => null,
    },
    getState: () => state,
    dispatch: action => { state = reduce(state, action); store.select(draftTarget(state).key) },
    busy: () => false, showToast: () => {}, errorMessage: String, afterResume: () => {},
  })
  await resume.resumeTopic('segment-a')
  assert.equal(draftTarget(state).key, first.key)
  assert.deepEqual(store.snapshot().files, [file])
  assert.deepEqual(store.snapshot().images, [image])
  assert.equal(store.snapshot().text, 'A draft')
  assert.equal(store.snapshot().error, 'A error')
  await resume.resumeTopic('continued-a-1')
  assert.equal(store.snapshot().key, first.key)
  state = reduce(state, { type: 'resume_ask', stage: 'gone', segmentId: 'segment-a', cwd: '/work' })
  await resume.resumeConfirm()
  assert.equal(store.snapshot().key, first.key, 'continuing from records keeps the backend topic identity')
  const reloaded = reduce(reduce(initialState, { type: 'ready', info: state.info }), {
    type: 'history_loaded', conversationId: 'carried-a', createdAt: 9999, messages: [{ role: 'user', text: 'saved words' }],
  })
  assert.equal(draftTarget(reloaded).key, first.key, 'history creation and resume timestamps do not change draft ownership')
})

test('new-topic readiness migrates the provisional draft and redirects late attachments and receipts', () => {
  const store = createComposerDraftStore()
  const original = { mode: 'live', model: 'local', cwd: '/work', topicId: 'topic-a', conversationId: 'segment-a' }
  let state = reduce(initialState, { type: 'new_session', info: original, at: 1000 })
  store.update('main', edit(store.select(draftTarget(state).key), 'prepared input'))
  state = reduce(state, { type: 'new_session_pending', at: 2000 })
  const pending = store.select(draftTarget(state).key, true)
  store.update('main', edit(pending, 'typed while preparing'))
  const sent = store.snapshot()
  state = reduce(state, { type: 'new_session_ready', info: { ...original, topicId: 'topic-b', conversationId: 'segment-b', sessionId: 'session-b' } })
  const ready = store.select(draftTarget(state).key, false, true)
  assert.equal(ready.text, 'typed while preparing')
  store.appendImage(pending.key, image)
  store.appendFiles(pending.key, [file])
  assert.deepEqual(store.snapshot().images, [image])
  assert.deepEqual(store.snapshot().files, [file])
  assert.equal(store.clear(sent), false, 'an earlier receipt cannot clear new attachments after migration')
  const saved = reduce(state, { type: 'conversation_saved', id: 'segment-b' })
  assert.equal(draftTarget(saved).key, ready.key)
  assert.equal(store.select('topic:topic-a').text, 'prepared input', 'migration never aliases the previous topic into the new one')
})
