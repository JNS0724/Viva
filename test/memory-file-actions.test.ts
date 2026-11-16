import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryActions } from '../src/renderer/memory-actions.ts'
import { createMemoryFileActions } from '../src/renderer/memory-file-actions.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import type { MemoryFileDetailView } from '../src/shared/ipc-results.ts'
import type { MemoryFileListResult, MemoryFileWriteResult } from '../src/memory/contracts/file-management.ts'

const version = (id: string) => ({ contentRevision: `body-${id}`, usageVersion: 4, policyToken: `policy-${id}` })
const detailOf = (id: string, kind: 'daily' | 'digest' = 'digest'): MemoryFileDetailView => ({
  identity: { kind, id, workspace: 'workspace' }, title: id, path: `${kind}/${id}.md`, version: version(id), enabled: true,
  applicability: 'current', ...(kind === 'daily' ? { hasProjection: true } : {}),
  actions: { setEnabled: true, stop: kind === 'daily', edit: false, forget: false, undo: kind === 'daily' ? null : { changeId: `change-${id}` } },
  markdown: `Body ${id}`, sources: [],
})
const pageOf = (items: MemoryFileListResult['items'], nextCursor: MemoryFileListResult['nextCursor'] = null): MemoryFileListResult => ({
  status: 'ok', snapshot: 'snapshot', items, nextCursor,
})
const getMemory = { fileMode: true, profile: {}, items: [], total: 0, onboarding: 'done', habits: { text: '', samples: 0 } }

function harness(api: Partial<AgentApi>) {
  const initial = reduce(reduce(initialState, { type: 'memory_open' }), { type: 'memory_loaded', data: getMemory })
  let state: State = initial
  const dispatch = (action: Action) => { state = reduce(state, action) }
  const notices: string[] = []
  const deps = { api: api as AgentApi, getState: () => state, dispatch, errorMessage: (error: unknown) => String(error),
    showToast: (notice: string) => { notices.push(notice) }, ask: () => false }
  return { actions: createMemoryFileActions(deps), all: createMemoryActions(deps), file: () => state.memory.files, notices, dispatch }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { resolve, promise }
}

/** The mutation fixture returns only a receipt, just like the owner. */
const mutationReceipt = (operationId: string, detail: MemoryFileDetailView, action: 'ENABLE' | 'DISABLE' | 'UNDO' | 'CREATE' | 'EDIT') => ({
  operationId, identity: detail.identity, usageVersion: detail.version.usageVersion + 1, contentRevision: detail.version.contentRevision, action,
})

test('file mode refreshes the file list and never queries the legacy search, profile or change action paths', async () => {
  const file = detailOf('useful')
  const calls: string[] = []
  const f = harness({
    getMemory: async () => { calls.push('mode'); return getMemory },
    listMemoryFiles: async () => { calls.push('file list'); return pageOf([file]) },
    listMemories: async () => { throw new Error('legacy fact search') },
  })
  f.dispatch({ type: 'memory_query', query: 'stale fact search' })
  await f.all.loadMemory()
  assert.deepEqual(calls, ['mode', 'file list'])
  assert.equal(f.file().items[0]?.identity.id, file.identity.id)
})

test('an old pagination cursor reloads the first page instead of appending obsolete file identities', async () => {
  const requests: Parameters<AgentApi['listMemoryFiles']>[0][] = []
  const old = detailOf('old'), current = detailOf('new')
  const cursor = { snapshot: 'snapshot', offset: 1 }
  const f = harness({ listMemoryFiles: async request => {
    requests.push(request)
    if (requests.length === 1) return pageOf([old], cursor)
    if (request.cursor) return { status: 'stale', snapshot: 'new', items: [], nextCursor: null }
    return pageOf([current])
  } })
  await f.actions.refreshFiles()
  await f.actions.loadMoreMemoryFiles()
  assert.deepEqual(requests.map(request => request.cursor), [undefined, cursor, undefined])
  assert.deepEqual(f.file().items.map(item => item.identity.id), ['new'])
})

test('detail version and panel generation both reject late data after a selection change or close', async () => {
  const first = detailOf('first'), second = detailOf('second')
  const reads = [deferred<MemoryFileDetailView>(), deferred<MemoryFileDetailView>(), deferred<MemoryFileDetailView>()]
  let index = 0
  const f = harness({ readMemoryFile: () => reads[index++]!.promise })
  const old = f.actions.showMemoryFile({ identity: first.identity })
  const current = f.actions.showMemoryFile({ identity: second.identity })
  reads[1]!.resolve(second)
  await current
  reads[0]!.resolve(first)
  await old
  assert.equal(f.file().detail, second)
  const closing = f.actions.showMemoryFile({ identity: first.identity })
  f.dispatch({ type: 'memory_close' })
  reads[2]!.resolve(first)
  await closing
  assert.equal(f.file().detail, null)
})

test('a memory change clears unread saved content and ignores an older detail reply of the same identity', async () => {
  const original = detailOf('same'), current = { ...original, markdown: 'Independent remaining body', version: version('new') }
  const oldReply = deferred<MemoryFileDetailView>()
  let first = true
  const f = harness({ readMemoryFile: async () => {
    if (first) { first = false; return oldReply.promise }
    return current
  }, listMemoryFiles: async () => pageOf([current]) })
  const reading = f.actions.showMemoryFile({ identity: original.identity })
  f.actions.invalidateFiles()
  await f.actions.refreshFiles()
  oldReply.resolve(original)
  await reading
  assert.equal(f.file().detail, current)
})

test('daily restore uses the selected archived policy version, and stop targets only the live projection', async () => {
  const current = detailOf('today', 'daily')
  const selected = { id: 'restriction-one', version: version('archived') }
  const independent = { id: 'restriction-two', version: version('independent') }
  const snapshot = { restrictionId: selected.id, markdown: 'Stopped evidence', sources: [] }
  let detail: MemoryFileDetailView = { ...current, restrictions: [selected, independent] }
  const requests: Parameters<AgentApi['setMemoryFileEnabled']>[0][] = []
  const f = harness({
    listMemoryFiles: async () => pageOf([detail]),
    readMemoryFile: async (_, restrictionId) => restrictionId === selected.id ? { ...detail, stoppedSnapshot: snapshot } : detail,
    setMemoryFileEnabled: async request => {
      requests.push(request)
      detail = { ...detail, restrictions: [independent], version: version(`current-${requests.length}`) }
      return mutationReceipt(request.operationId, detail, request.enabled ? 'ENABLE' : 'DISABLE')
    },
  })
  await f.actions.showMemoryFile({ identity: current.identity })
  const live = f.file().detail!
  assert.equal(await f.actions.setManagedMemoryEnabled(live, true, selected.id), false, 'a range must be explicitly viewed first')
  assert.equal(await f.actions.setManagedMemoryEnabled(live, true), false, 'daily has no blanket restore')
  await f.actions.showMemoryFile({ identity: current.identity, restrictionId: selected.id })
  assert.equal(await f.actions.setManagedMemoryEnabled(f.file().detail!, true, independent.id), false)
  assert.equal(await f.actions.setManagedMemoryEnabled(f.file().detail!, false), false, 'an archived detail cannot stop the current note')
  assert.equal(await f.actions.setManagedMemoryEnabled(f.file().detail!, true, selected.id), true)
  assert.deepEqual(f.file().selection, { identity: current.identity })
  assert.deepEqual(f.file().detail?.restrictions, [independent])
  assert.equal(await f.actions.setManagedMemoryEnabled(live, false), false, 'an obsolete click closure is not a current target')
  assert.equal(await f.actions.setManagedMemoryEnabled(f.file().detail!, false), true)
  assert.deepEqual(requests.map(({ enabled, version, restrictionId }) => ({ enabled, version, restrictionId })), [
    { enabled: true, version: selected.version, restrictionId: selected.id },
    { enabled: false, version: version('current-1'), restrictionId: undefined },
  ])
})

test('a digest undo binds exact change and policy versions and refreshes a rejected write', async () => {
  const old = detailOf('digest'), current = { ...old, version: version('new'), actions: { ...old.actions, undo: null } }
  const requests: Parameters<AgentApi['undoMemoryFile']>[0][] = []
  const gate = deferred<void>()
  const f = harness({
    readMemoryFile: async () => requests.length ? current : old,
    listMemoryFiles: async () => pageOf([current]),
    undoMemoryFile: async request => {
      requests.push(request)
      await gate.promise
      throw new Error('version conflict')
    },
  })
  await f.actions.showMemoryFile({ identity: old.identity })
  const undo = f.actions.undoManagedMemory(old)
  assert.equal(f.file().writing, true)
  assert.equal(await f.actions.undoManagedMemory(old), false)
  gate.resolve()
  assert.equal(await undo, false)
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0]?.version, old.version)
  assert.equal(requests[0]?.changeId, old.actions.undo?.changeId)
  assert.equal(f.file().detail, current)
  assert.match(f.file().writeError ?? '', /version conflict/)
  assert.equal(f.notices.length, 0)
})

test('digest stop and resume each take the currently read document version with no daily restriction authority', async () => {
  let item = detailOf('digest')
  const original = item.version
  const requests: Parameters<AgentApi['setMemoryFileEnabled']>[0][] = []
  const f = harness({
    readMemoryFile: async () => item,
    listMemoryFiles: async () => pageOf([item]),
    setMemoryFileEnabled: async request => {
      requests.push(request)
      item = { ...item, enabled: request.enabled, version: { ...item.version, usageVersion: item.version.usageVersion + 1 } }
      return mutationReceipt(request.operationId, item, request.enabled ? 'ENABLE' : 'DISABLE')
    },
  })
  await f.actions.showMemoryFile({ identity: item.identity })
  assert.equal(await f.actions.setManagedMemoryEnabled(f.file().detail!, true), false)
  assert.equal(await f.actions.setManagedMemoryEnabled(f.file().detail!, false), true)
  assert.equal(await f.actions.setManagedMemoryEnabled(f.file().detail!, true), true)
  assert.deepEqual(requests.map(({ enabled, version, restrictionId }) => ({ enabled, version, restrictionId })), [
    { enabled: false, version: original, restrictionId: undefined },
    { enabled: true, version: { ...original, usageVersion: original.usageVersion + 1 }, restrictionId: undefined },
  ])
})


const editable = (file: MemoryFileDetailView, title: string, text: string): MemoryFileDetailView => ({
  ...file, editor: { title, text }, actions: { ...file.actions, edit: true },
})

test('manual creation replays the same wire request when a blank title changes after an unconfirmed receipt', async () => {
  const item = detailOf('manual')
  const requests: Parameters<AgentApi['createMemoryFile']>[0][] = []
  const f = harness({
    listMemoryFiles: async () => pageOf([item]), readMemoryFile: async () => item,
    createMemoryFile: async request => {
      requests.push(request)
      if (requests.length === 1) throw new Error('Owner transport interrupted')
      return { status: 'applied', receipt: mutationReceipt(request.operationId, item, 'CREATE') }
    },
  })
  f.actions.startMemoryFileEditor()
  const id = f.file().editor!.id
  const draft = { title: '', text: 'Record this exactly.\n\nSecond paragraph. ' }
  assert.equal(await f.actions.saveMemoryFileEditor(id, { ...draft, text: '  ' }), false)
  assert.equal(requests.length, 0)
  assert.equal(await f.actions.saveMemoryFileEditor(id, draft), false)
  assert.deepEqual(f.file().editor?.draft, draft)
  assert.ok(f.file().editor?.error)
  assert.equal(f.file().writing, false)
  assert.equal(await f.actions.saveMemoryFileEditor(id, { ...draft, title: '  ' }), true)
  assert.deepEqual(requests, [requests[0], requests[0]])
  assert.deepEqual(requests[0], { operationId: requests[0]!.operationId, text: draft.text })
  assert.equal(f.file().editor, null)
  assert.equal(f.file().detail, item)
  assert.equal(f.notices.length, 1)
})

test('manual edit omits an untouched projected title with trailing masking spaces', async () => {
  const projectedTitle = `Note: before${' '.repeat(36)}`
  const file = editable(detailOf('partially-withdrawn'), projectedTitle, 'Remaining text')
  const requests: Parameters<AgentApi['editMemoryFile']>[0][] = []
  const f = harness({
    readMemoryFile: async () => file, listMemoryFiles: async () => pageOf([file]),
    editMemoryFile: async request => {
      requests.push(request)
      return { status: 'applied', receipt: mutationReceipt(request.operationId, file, 'EDIT') }
    },
  })
  await f.actions.showMemoryFile({ identity: file.identity })
  for (const text of ['Remaining text', 'Body-only edit']) {
    f.actions.startMemoryFileEditor(file)
    const editor = f.file().editor!
    assert.equal(editor.draft.title, projectedTitle)
    assert.equal(await f.actions.saveMemoryFileEditor(editor.id, { title: projectedTitle, text }), true)
  }
  assert.deepEqual(requests.map(({ operationId, ...request }) => request), [
    { identity: file.identity, version: file.version, text: 'Remaining text' },
    { identity: file.identity, version: file.version, text: 'Body-only edit' },
  ])
})

test('manual edit retains the operation after change.pending and preserves the raw draft', async () => {
  const file = editable(detailOf('editable'), 'Current title', 'Current text')
  const requests: Parameters<AgentApi['editMemoryFile']>[0][] = []
  const f = harness({
    readMemoryFile: async () => file, listMemoryFiles: async () => pageOf([file]),
    editMemoryFile: async request => {
      requests.push(request)
      return requests.length === 1 ? { status: 'rejected', code: 'change.pending' }
        : { status: 'applied', receipt: mutationReceipt(request.operationId, file, 'EDIT') }
    },
  })
  await f.actions.showMemoryFile({ identity: file.identity })
  f.actions.startMemoryFileEditor(file)
  const id = f.file().editor!.id
  const draft = { title: '  Updated title ', text: 'Updated text' }
  assert.equal(await f.actions.saveMemoryFileEditor(id, draft), false)
  assert.deepEqual(f.file().editor?.draft, draft)
  assert.ok(f.file().editor?.error)
  assert.equal(await f.actions.saveMemoryFileEditor(id, { ...draft, title: 'Updated title' }), true)
  assert.deepEqual(requests, [requests[0], requests[0]])
  assert.equal(requests[0]?.title, 'Updated title')
})

test('manual edit keeps a rejected draft and binds retry to the exact latest version only after reopening it', async () => {
  const old = editable(detailOf('draft'), 'Old title', 'Original body')
  let latest = editable({ ...old, version: { ...version('latest'), usageVersion: 8 } }, 'New title', 'Accepted latest body')
  const requests: Parameters<AgentApi['editMemoryFile']>[0][] = []
  const f = harness({
    readMemoryFile: async () => requests.length ? latest : old,
    listMemoryFiles: async () => pageOf([latest]),
    editMemoryFile: async request => {
      requests.push(request)
      return requests.length === 1 ? { status: 'rejected', code: 'revision.conflict' }
        : { status: 'applied', receipt: mutationReceipt(request.operationId, latest, 'EDIT') }
    },
  })
  await f.actions.showMemoryFile({ identity: old.identity })
  f.actions.startMemoryFileEditor(old)
  const id = f.file().editor!.id
  const draft = { title: 'New local title', text: 'Draft using old evidence' }
  assert.deepEqual(f.file().editor?.draft, old.editor)
  assert.equal(await f.actions.saveMemoryFileEditor(id, draft), false)
  assert.deepEqual(requests[0], { operationId: requests[0]!.operationId, identity: old.identity, version: old.version, ...draft })
  assert.equal(f.file().editor?.conflict, true)
  assert.deepEqual(f.file().editor?.draft, draft)
  assert.equal(f.file().detail, latest)
  assert.equal(await f.actions.saveMemoryFileEditor(id, draft), false, 'ordinary submit cannot overwrite unseen revisions')
  const reviewed = latest
  latest = { ...latest, version: version('newer') }
  await f.actions.reloadMemoryFile()
  f.actions.acceptMemoryFileEditVersion(id, reviewed)
  assert.equal(f.file().editor?.conflict, true, 'only the precise preview that remains current can be opened')
  f.actions.acceptMemoryFileEditVersion(id, latest)
  assert.equal(f.file().editor?.conflict, undefined)
  assert.deepEqual(f.file().editor?.draft, latest.editor, 'old text is never automatically applied to new evidence')
  assert.equal(await f.actions.saveMemoryFileEditor(id, draft), false, 'old form events cannot cross editor generations')
  const newDraft = { title: '', text: 'New draft based on the latest version' }
  assert.equal(await f.actions.saveMemoryFileEditor(f.file().editor!.id, newDraft), true)
  assert.deepEqual(requests[1], { operationId: requests[1]!.operationId, identity: latest.identity, version: latest.version, ...newDraft })
  assert.notEqual(requests[0]!.operationId, requests[1]!.operationId)
})

test('manual edit checks capability and exact selection, including stopped snapshots and older details', async () => {
  const daily = detailOf('today', 'daily')
  const digest = editable(detailOf('active'), '', 'Body')
  const f = harness({ readMemoryFile: async (identity, restrictionId) => identity.kind === 'daily' ? daily : restrictionId
    ? { ...digest, stoppedSnapshot: { restrictionId, markdown: 'Archived body', sources: [] } } : digest })
  await f.actions.showMemoryFile({ identity: daily.identity })
  f.actions.startMemoryFileEditor(digest)
  f.actions.startMemoryFileEditor(daily)
  assert.equal(f.file().editor, null)
  await f.actions.showMemoryFile({ identity: digest.identity, restrictionId: 'archived' })
  f.actions.startMemoryFileEditor(f.file().detail!)
  assert.equal(f.file().editor, null)
  await f.actions.showMemoryFile({ identity: digest.identity })
  f.actions.startMemoryFileEditor(digest)
  const id = f.file().editor!.id
  f.actions.cancelMemoryFileEditor(id)
  f.actions.startMemoryFileEditor(digest)
  assert.notEqual(f.file().editor?.id, id)
  f.actions.cancelMemoryFileEditor(id)
  assert.ok(f.file().editor)
})

test('a durable create result after close and reopen cannot steal the current selection or show a stale notice', async () => {
  const created = detailOf('created'), current = detailOf('current')
  const pending = deferred<MemoryFileWriteResult>()
  let operationId = ''
  const f = harness({
    createMemoryFile: request => { operationId = request.operationId; return pending.promise },
    listMemoryFiles: async () => pageOf([created, current]),
    readMemoryFile: async identity => identity.id === current.identity.id ? current : created,
  })
  f.actions.startMemoryFileEditor()
  const saving = f.actions.saveMemoryFileEditor(f.file().editor!.id, { title: 'Manual note', text: 'Remember this' })
  assert.equal(f.file().writing, true)
  f.dispatch({ type: 'memory_close' })
  f.dispatch({ type: 'memory_open' })
  await f.actions.showMemoryFile({ identity: current.identity })
  pending.resolve({ status: 'applied', receipt: mutationReceipt(operationId, created, 'CREATE') })
  assert.equal(await saving, true)
  assert.equal(f.file().writing, false)
  assert.equal(f.file().detail, current)
  assert.deepEqual(f.notices, [])
})
