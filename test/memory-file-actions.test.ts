import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryActions } from '../src/renderer/memory-actions.ts'
import { createMemoryFileActions } from '../src/renderer/memory-file-actions.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import type { MemoryFileDetailView } from '../src/shared/ipc-results.ts'
import type { MemoryFileListResult } from '../src/memory/contracts/file-management.ts'

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
const mutationReceipt = (operationId: string, detail: MemoryFileDetailView, action: 'ENABLE' | 'DISABLE' | 'UNDO') => ({
  operationId, identity: detail.identity, usageVersion: detail.version.usageVersion + 1, contentRevision: detail.version.contentRevision, action,
})

test('loading About You refreshes the file list after the profile', async () => {
  const file = detailOf('useful')
  const calls: string[] = []
  const f = harness({
    getMemory: async () => { calls.push('profile'); return getMemory },
    listMemoryFiles: async () => { calls.push('file list'); return pageOf([file]) },
  })
  await f.all.loadMemory()
  assert.deepEqual(calls, ['profile', 'file list'])
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
