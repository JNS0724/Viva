import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryActions } from '../src/renderer/memory-actions.ts'
import { createMemoryFileActions, createMemoryPageReads } from '../src/renderer/memory-file-actions.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import type { MemoryFileDetailView } from '../src/shared/ipc-results.ts'
import type { MemoryFileListResult, MemoryFileWriteResult } from '../src/memory/contracts/file-management.ts'
import { MEMORY_READ_BUDGET_MS } from '../src/shared/request-budget.ts'

const version = (id: string) => ({ contentRevision: `body-${id}`, usageVersion: 4, policyToken: `policy-${id}` })
const detailOf = (id: string, kind: 'daily' | 'digest' = 'digest'): MemoryFileDetailView => ({
  identity: { kind, id, workspace: 'workspace' }, title: id, path: `${kind}/${id}.md`, version: version(id), enabled: true,
  actions: { setEnabled: true, edit: false, forget: false, undo: kind === 'daily' ? null : { changeId: `change-${id}` } },
  markdown: `Body ${id}`, sources: [],
})
const pageOf = (items: MemoryFileListResult['items'], nextCursor: MemoryFileListResult['nextCursor'] = null): MemoryFileListResult => ({
  status: 'ok', snapshot: 'snapshot', items, nextCursor,
})
const getMemory = { profile: {}, items: [], total: 0, onboarding: 'done', habits: { text: '', samples: 0 } }

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
const mutationReceipt = (operationId: string, detail: MemoryFileDetailView, action: 'ENABLE' | 'DISABLE' | 'UNDO' | 'CREATE' | 'EDIT' | 'FORGET') => ({
  operationId, identity: detail.identity, usageVersion: detail.version.usageVersion + 1, contentRevision: detail.version.contentRevision, action,
})

test('a partial list stays marked through pagination and clears after a complete refresh', () => {
  const f = harness({})
  const listed = (page: MemoryFileListResult, more: boolean) => f.dispatch({ type: 'memory_files_listed', query: '', page, more })
  listed({ ...pageOf([detailOf('one')]), partial: true }, false)
  listed(pageOf([detailOf('two')]), true)
  assert.deepEqual(f.file().items.map(item => item.title), ['one', 'two'])
  assert.equal(f.file().partial, true)
  listed(pageOf([detailOf('one')]), false)
  assert.equal(f.file().partial, false)
})

test('a completed retry page clears the partial indicator while keeping healthy results', () => {
  const f = harness({})
  const page = pageOf([detailOf('healthy')], { snapshot: 'unchanged', offset: 2, retry: [0] })
  f.dispatch({ type: 'memory_files_listed', query: '', page: { ...page, partial: true }, more: false })
  assert.equal(f.file().partial, true)
  f.dispatch({ type: 'memory_files_listed', query: '', page: pageOf([detailOf('recovered')]), more: true })
  assert.equal(f.file().partial, false)
  assert.deepEqual(f.file().items.map(item => item.title), ['healthy', 'recovered'])
})

test('permanent file forget requires capability and current explicit confirmation before preserving one retry identity', async () => {
  const old = detailOf('private'), allowed = { ...old, actions: { ...old.actions, forget: true } }
  const other = detailOf('from-same-source')
  const requests: Parameters<AgentApi['forgetMemoryFile']>[0][] = []
  const f = harness({ readMemoryFile: async () => requests.length ? null : allowed,
    listMemoryFiles: async () => pageOf(requests.length ? [other] : [allowed, other]),
    forgetMemoryFile: async request => {
      requests.push(request)
      if (requests.length === 1) throw new Error('reply lost after owner commit')
      return { status: 'applied', receipt: mutationReceipt(request.operationId, allowed, 'FORGET'),
        cleanup: requests.length === 2 ? 'pending' : 'complete' }
    },
  })
  await f.actions.refreshFiles()
  await f.actions.showMemoryFile({ identity: old.identity })
  f.actions.askManagedMemoryForget(old)
  assert.equal(f.file().forget, null, 'a stale or disabled capability cannot open confirmation')
  f.actions.askManagedMemoryForget(allowed)
  const confirm = f.file().forget!
  assert.equal(confirm.phase, 'confirm')
  assert.equal(requests.length, 0)
  assert.equal(await f.actions.confirmManagedMemoryForget(confirm.id + 1), false)
  assert.equal(await f.actions.confirmManagedMemoryForget(confirm.id), false)
  assert.equal(f.file().forget?.phase, 'unconfirmed')
  assert.equal(f.file().forget?.title, undefined, 'potentially erased title is no longer retained')
  assert.equal(f.file().detail, null)
  assert.equal(f.file().selection, null)
  assert.deepEqual(f.file().items, [other], 'only the selected file leaves the list')
  assert.equal(await f.actions.undoManagedMemory(allowed), false, 'an old Undo closure cannot restore forgotten content')
  f.actions.invalidateFiles()
  assert.equal(f.file().forget?.request.operationId, confirm.request.operationId)
  assert.equal(await f.actions.confirmManagedMemoryForget(confirm.id), true)
  assert.equal(f.file().forget?.phase, 'pending', 'a pending receipt keeps the same request available for a status check')
  assert.equal(await f.actions.confirmManagedMemoryForget(confirm.id), true)
  assert.equal(f.file().forget?.phase, 'complete')
  assert.deepEqual(requests, [confirm.request, confirm.request, confirm.request])
})

test('new proof requires a new forget confirmation and stale responses cannot target a later selection', async () => {
  const original = detailOf('changing'), current = { ...original, actions: { ...original.actions, forget: true } }
  const other = detailOf('other'), pending = deferred<Awaited<ReturnType<AgentApi['forgetMemoryFile']>>>()
  let calls = 0, request: Parameters<AgentApi['forgetMemoryFile']>[0] | undefined
  const f = harness({ readMemoryFile: async identity => identity.id === other.identity.id ? other : current,
    listMemoryFiles: async () => pageOf([other]), forgetMemoryFile: input => { calls++; request = input; return pending.promise } })
  await f.actions.showMemoryFile({ identity: current.identity })
  f.actions.askManagedMemoryForget(current)
  const first = f.file().forget!
  f.actions.invalidateFiles()
  assert.equal(f.file().forget, null)
  assert.equal(await f.actions.confirmManagedMemoryForget(first.id), false)
  assert.equal(calls, 0)
  await f.actions.reloadMemoryFile()
  f.actions.askManagedMemoryForget(current)
  const second = f.file().forget!
  assert.notEqual(second.request.operationId, first.request.operationId)
  const sending = f.actions.confirmManagedMemoryForget(second.id)
  assert.equal(await f.actions.confirmManagedMemoryForget(second.id), false)
  f.dispatch({ type: 'memory_close' })
  f.dispatch({ type: 'memory_open' })
  await f.actions.showMemoryFile({ identity: other.identity })
  pending.resolve({ status: 'applied', receipt: mutationReceipt(request!.operationId, current, 'FORGET'), cleanup: 'complete' })
  assert.equal(await sending, true)
  assert.equal(f.file().detail, other)
  assert.equal(f.file().forget, null)
  assert.equal(calls, 1)
})

test('a changed file version requires a new review and operation before deletion', async () => {
  const item = detailOf('changed'), old = { ...item, actions: { ...item.actions, forget: true } }
  const latest = { ...old, version: version('edited'), markdown: 'Edited since review' }
  const requests: Parameters<AgentApi['forgetMemoryFile']>[0][] = []
  const f = harness({ readMemoryFile: async () => requests.length ? latest : old, listMemoryFiles: async () => pageOf([latest]),
    forgetMemoryFile: async request => {
      requests.push(request)
      return requests.length === 1 ? { status: 'rejected', code: 'revision.conflict' }
        : { status: 'applied', cleanup: 'complete', receipt: mutationReceipt(request.operationId, latest, 'FORGET') }
    } })
  await f.actions.showMemoryFile({ identity: item.identity })
  f.actions.askManagedMemoryForget(old)
  const first = f.file().forget!
  assert.equal(await f.actions.confirmManagedMemoryForget(first.id), false)
  assert.equal(f.file().forget?.phase, 'conflict')
  assert.equal(await f.actions.confirmManagedMemoryForget(first.id), false)
  await f.actions.showMemoryFile({ identity: item.identity })
  f.actions.askManagedMemoryForget(old)
  assert.equal(requests.length, 1)
  f.actions.askManagedMemoryForget(latest)
  const second = f.file().forget!
  assert.notEqual(second.request.operationId, first.request.operationId)
  assert.equal(await f.actions.confirmManagedMemoryForget(second.id), true)
  assert.deepEqual(requests.map(request => request.version), [old.version, latest.version])
})

test('About You can search files while the profile request is still outstanding', async () => {
  const file = detailOf('useful')
  const profile = deferred<typeof getMemory>()
  const queries: string[] = []
  const f = harness({
    getMemory: () => profile.promise,
    listMemoryFiles: async ({ query }) => { queries.push(query ?? ''); return pageOf([file]) },
  })
  const loading = f.all.loadMemory()
  await Promise.resolve()
  assert.equal(f.file().items[0]?.identity.id, file.identity.id)
  f.all.searchMemoryFiles('useful')
  await f.all.reloadMemoryFileList()
  assert.deepEqual(queries, ['', 'useful'])
  profile.resolve(getMemory)
  await loading
  f.all.closeProfile()
})

test('a change during profile loading refreshes files immediately and discards the old profile reply', async () => {
  const first = deferred<typeof getMemory>()
  let profiles = 0, lists = 0
  const f = harness({
    getMemory: () => ++profiles === 1 ? first.promise : Promise.resolve(getMemory),
    listMemoryFiles: async () => pageOf([detailOf(String(++lists))]),
  })
  const loading = f.all.loadMemory()
  await Promise.resolve()
  f.all.onMemoryChanged({})
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(f.file().items[0]?.identity.id, '2')
  assert.equal(profiles, 1)
  first.resolve(getMemory)
  assert.equal(await loading, true)
  assert.equal(profiles, 2)
  assert.equal(lists, 2)
})

test('Dream change notifications during a slow file list coalesce into one fresh list', async () => {
  const first = deferred<MemoryFileListResult>()
  let lists = 0
  const f = harness({ getMemory: async () => getMemory,
    listMemoryFiles: async () => ++lists === 1 ? first.promise : pageOf([detailOf('current')]) })
  await f.all.loadMemory()
  for (let i = 0; i < 5; i++) f.all.onMemoryChanged({})
  assert.equal(lists, 1)
  first.resolve(pageOf([detailOf('stale')]))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(lists, 2)
  assert.deepEqual(f.file().items.map(item => item.identity.id), ['current'])
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

test('a title search follows empty pages and stops when the query changes', async () => {
  const requests: Array<Parameters<AgentApi['listMemoryFiles']>[0]> = []
  const cursor = { snapshot: 'snapshot', offset: 100 }
  const abandoned = deferred<MemoryFileListResult>()
  const f = harness({ async listMemoryFiles(request) {
    requests.push(request)
    if (request.query === 'first' && request.cursor) return pageOf([detailOf('later-result')])
    if (request.query === 'abandoned' && request.cursor) return abandoned.promise
    return pageOf([], cursor)
  } })
  f.dispatch({ type: 'memory_files_query', query: 'first' })
  await f.actions.refreshFiles()
  assert.deepEqual(requests.map(request => request.cursor), [undefined, cursor])
  assert.deepEqual(f.file().items.map(item => item.identity.id), ['later-result'])

  f.dispatch({ type: 'memory_files_query', query: 'abandoned' })
  const pending = f.actions.refreshFiles()
  await Promise.resolve()
  f.dispatch({ type: 'memory_files_query', query: 'new' })
  abandoned.resolve(pageOf([], { ...cursor, offset: 200 }))
  await pending
  assert.equal(requests.length, 4)
  assert.equal(f.file().items.length, 0)
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

test('daily stop and resume use the current whole-file version', async () => {
  const current = detailOf('today', 'daily')
  let detail = current
  const requests: Parameters<AgentApi['setMemoryFileEnabled']>[0][] = []
  const f = harness({
    listMemoryFiles: async () => pageOf([detail]),
    readMemoryFile: async () => detail,
    setMemoryFileEnabled: async request => {
      requests.push(request)
      detail = { ...detail, enabled: request.enabled, version: version(`current-${requests.length}`) }
      return mutationReceipt(request.operationId, detail, request.enabled ? 'ENABLE' : 'DISABLE')
    },
  })
  await f.actions.showMemoryFile({ identity: current.identity })
  assert.equal(await f.actions.setManagedMemoryEnabled(current, true), false)
  assert.equal(await f.actions.setManagedMemoryEnabled(current, false), true)
  assert.equal(await f.actions.setManagedMemoryEnabled(current, false), false)
  assert.equal(await f.actions.setManagedMemoryEnabled(f.file().detail!, true), true)
  assert.deepEqual(requests.map(({ enabled, version }) => ({ enabled, version })), [
    { enabled: false, version: current.version },
    { enabled: true, version: version('current-1') },
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
  assert.deepEqual(requests.map(({ enabled, version }) => ({ enabled, version })), [
    { enabled: false, version: original },
    { enabled: true, version: { ...original, usageVersion: original.usageVersion + 1 } },
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

test('manual edit checks capability and exact selection, including older details', async () => {
  const daily = detailOf('today', 'daily')
  const digest = editable(detailOf('active'), '', 'Body')
  const f = harness({ readMemoryFile: async identity => identity.kind === 'daily' ? daily : digest })
  await f.actions.showMemoryFile({ identity: daily.identity })
  f.actions.startMemoryFileEditor(digest)
  f.actions.startMemoryFileEditor(daily)
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

test('the first unfiltered page can change revision and skip an entire filtered page', async () => {
  const requests: Parameters<AgentApi['listMemoryFiles']>[0][] = []
  const cursor = { snapshot: 'snapshot', offset: 100 }
  const f = harness({ async listMemoryFiles(request) {
    requests.push(request)
    if (requests.length === 1) return { status: 'stale', snapshot: 'old', items: [], nextCursor: null }
    return request.cursor ? pageOf([detailOf('visible')]) : pageOf([], cursor)
  } })
  await f.actions.refreshFiles()
  assert.deepEqual(requests.map(request => request.cursor), [undefined, undefined, cursor])
  assert.deepEqual(f.file().items.map(item => item.identity.id), ['visible'])
})

test('a file detail refresh shares pending work and leaves the second owner read slot for the profile', async () => {
  const item = detailOf('active')
  const loading = deferred<MemoryFileDetailView>()
  let details = 0, lists = 0
  const f = harness({ getMemory: async () => getMemory,
    listMemoryFiles: async () => { lists++; return pageOf([item]) },
    readMemoryFile: async () => ++details === 2 ? loading.promise : item })
  await f.actions.showMemoryFile({ identity: item.identity })
  const first = f.actions.refreshFiles()
  const second = f.actions.refreshFiles()
  assert.equal(details, 2)
  assert.equal(lists, 0)
  loading.resolve(item)
  await Promise.all([first, second])
  assert.equal(details, 3)
  assert.equal(lists, 0)
  await f.actions.showMemoryFile(null)
  assert.equal(lists, 1)
})

test('returning to the list can use the first released slot while the old detail read is still running', async () => {
  const item = detailOf('active'), profile = deferred<typeof getMemory>(), old = deferred<MemoryFileDetailView>()
  let profiles = 0, details = 0, lists = 0
  let listBudget: number | undefined
  const f = harness({
    getMemory: () => { profiles++; return profile.promise },
    readMemoryFile: async () => ++details === 1 ? item : old.promise,
    listMemoryFiles: async (_query, options) => { lists++; listBudget = options?.budgetMs; return pageOf([item]) },
  })
  await f.all.showMemoryFile({ identity: item.identity })
  f.all.onMemoryChanged({})
  await Promise.resolve()
  assert.equal(details, 2)
  assert.equal(profiles, 1)
  const back = f.all.showMemoryFile(null)
  assert.equal(f.file().selection, null)
  assert.equal(lists, 0, 'the old detail and profile are occupying both owner slots')
  profile.resolve(getMemory)
  await back
  assert.equal(lists, 1)
  assert.ok(listBudget !== undefined && listBudget > 0 && listBudget < MEMORY_READ_BUDGET_MS)
  assert.equal(f.file().listError, null)
  assert.equal(f.file().items[0]?.identity.id, item.identity.id)
  old.resolve(item)
})

test('an expired page read does not start later when a physical slot is released', async t => {
  const reads = createMemoryPageReads(20), held = deferred<void>()
  t.after(() => held.resolve())
  const first = reads(() => true, () => held.promise), second = reads(() => true, () => held.promise)
  let started = false
  await assert.rejects(reads(() => true, async () => { started = true }), /timed out/)
  held.resolve()
  await Promise.all([first, second])
  assert.equal(started, false)
})

test('leaving a page ends its queued read even while both active slots stay occupied', async t => {
  const reads = createMemoryPageReads(), held = deferred<void>()
  t.after(() => held.resolve())
  const active = [reads(() => true, () => held.promise), reads(() => true, () => held.promise)]
  let visible = true
  const blocked = reads(() => visible, async () => assert.fail('stale page started reading'))
  await new Promise<void>(resolve => setImmediate(resolve))
  visible = false
  reads.wakeWaiters()
  await assert.rejects(blocked, /timed out/)
  held.resolve()
  await Promise.all(active)
})
