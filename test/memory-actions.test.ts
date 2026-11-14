import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryActions, introChanges, introPrompt, memoryNotice } from '../src/renderer/memory-actions.ts'
import { initialState, reduce } from '../src/renderer/state.ts'

test('memory notices distinguish saved memories from facts that stopped counting', () => {
  assert.equal(memoryNotice({ memories: ['直属上级是李四'], invalidated: ['张三是直属上级'] }), '已记住：直属上级是李四；「张三是直属上级」已不再使用')
  assert.equal(memoryNotice({ invalidated: ['a', 'b'] }), '2 条旧记忆已不再使用')
})

test('a restored memory moves out of the inactive list', () => {
  const inactive = { id: 7, revision: 2, text: '张三是直属上级', invalidAt: 1, retention: 'forgotten' }
  const loaded = reduce(initialState, { type: 'memory_loaded', data: {
    profile: {}, items: [], total: 0, invalid: 1, onboarding: 'done', habits: { text: '', samples: 0 },
  } })
  const opened = reduce(reduce(loaded, { type: 'memory_invalid_opened' }), { type: 'memory_invalid_listed', items: [inactive] })
  const revived = reduce(opened, { type: 'memory_revived', memory: { ...inactive, revision: 3, invalidAt: null, retention: 'retained' } })
  assert.equal(opened.memory.invalidOpen, true)
  assert.deepEqual([revived.memory.invalid, revived.memory.invalidItems, revived.memory.items.map(item => item.id), revived.memory.total], [0, [], [7], 1])
  assert.equal(reduce(opened, { type: 'memory_invalid_closed' }).memory.invalidOpen, false)
})

test('the intro saves only the profile fields and lists sites and documents in the reading prompt', () => {
  assert.deepEqual(introChanges({ role: ' 后端负责人 ', projects: '', preferences: '先给结论', sources: 'https://wiki.example', email: 'x' }),
    { role: '后端负责人', preferences: '先给结论' })
  assert.match(introPrompt({ sources: ['https://wiki.example'], docs: [{ path: '/w/我的资料/周报.md' }] }), /- https:\/\/wiki\.example\n- \/w\/我的资料\/周报\.md$/)
})

test('editing keeps its target on refresh and submits the displayed revision', async () => {
  const memory = { id: 7, revision: 3, text: '回答先给结论' }
  let state: State = initialState
  const writes: Parameters<AgentApi['updateMemory']>[] = []
  const api: Pick<AgentApi, 'updateMemory' | 'listMemories' | 'getMemory'> = {
    updateMemory: async (...args) => { writes.push(args); return true },
    getMemory: async () => ({ items: [{ ...memory, revision: 4 }], total: 1 }),
    listMemories: async () => ({ items: [{ ...memory, text: '先给结论再给例子', revision: 4 }], total: 1 }),
  }
  const actions = createMemoryActions({
    api: api as AgentApi, getState: () => state, dispatch: action => { state = reduce(state, action) },
    showToast: () => {}, errorMessage: String, ask: () => false,
  })
  actions.editMemoryEntry({ id: memory.id, revision: memory.revision })
  await actions.loadMemory()
  assert.deepEqual(state.memory.editingMemory, { id: 7, revision: 3 })
  assert.equal(state.memory.items[0].revision, 4)
  await actions.editMemory(state.memory.editingMemory!, '先给结论再给例子')
  assert.deepEqual(writes[0].slice(0, 3), [7, '先给结论再给例子', 3])
  assert.match(String(writes[0][3]), /^[0-9a-f-]{36}$/)
  assert.equal(state.memory.editingMemory, null)
  assert.equal(state.memory.items[0].revision, 4)
})

test('confirming a disputed memory sends both displayed revisions and refreshes both lists', async () => {
  const memory = { id: 9, revision: 6, text: '我的直属上级是李四' }
  const other = { id: 2, revision: 7, text: '我的直属上级是王五' }
  let state: State = reduce(reduce(initialState, { type: 'memory_invalid_opened' }), { type: 'memory_invalid_listed', items: [memory, other] })
  const writes: Parameters<AgentApi['resolveMemoryConflictPair']>[] = []
  const api: Pick<AgentApi, 'getMemory' | 'listInvalidMemories' | 'resolveMemoryConflictPair'> = {
    getMemory: async () => ({ items: [memory], total: 1, invalid: 0 }),
    listInvalidMemories: async () => [],
    resolveMemoryConflictPair: async (...args) => { writes.push(args); return true },
  }
  const actions = createMemoryActions({
    api: api as AgentApi, getState: () => state, dispatch: action => { state = reduce(state, action) },
    showToast: () => {}, errorMessage: String, ask: () => false,
  })
  const interval = { from: 1, to: 2 }
  assert.equal(await actions.resolveMemoryConflictPair(memory, other, { kind: 'keep-first' }, 11, interval), true)
  assert.deepEqual(writes[0].slice(0, 3), [{ id: 9, revision: 6 }, { id: 2, revision: 7 }, { kind: 'keep-first' }])
  assert.equal(writes[0][4], 11)
  assert.deepEqual(writes[0][5], interval)
  assert.deepEqual(state.memory.items, [memory])
  assert.deepEqual(state.memory.invalidItems, [])
})

test('undo uses the displayed change revision and refreshes the history', async () => {
  const change: import('../src/shared/ipc-results.ts').MemoryChangeRecord = {
    id: 4, revision: 12, kind: 'supersede', status: 'applied', before: '旧提交邮箱', after: '新提交邮箱',
    scope: { kind: 'user' }, from: 1, to: null, createdAt: 1, effectiveAt: 1, evidence: [],
    expectedRevisions: [{ id: 7, revision: 11 }, { id: 9, revision: 12 }],
  }
  let state: State = initialState
  const writes: Parameters<AgentApi['undoMemoryChange']>[] = []
  const api: Pick<AgentApi, 'getMemory' | 'listMemoryChanges' | 'undoMemoryChange'> = {
    getMemory: async () => ({ items: [], total: 0 }),
    listMemoryChanges: async () => writes.length ? [{ ...change, revision: 13, status: 'undone' }] : [change],
    undoMemoryChange: async (...args) => { writes.push(args); return { status: 'applied' } },
  }
  const actions = createMemoryActions({
    api: api as AgentApi, getState: () => state, dispatch: action => { state = reduce(state, action) },
    showToast: () => {}, errorMessage: String, ask: () => false,
  })
  await actions.toggleMemoryChanges()
  assert.equal(state.memory.changesLoaded, true)
  assert.equal(state.memory.changes[0].status, 'applied')
  await actions.undoMemoryChange(change)
  assert.deepEqual(writes[0].slice(0, 2), [4, 12])
  assert.match(writes[0][2], /^[0-9a-f-]{36}$/)
  assert.deepEqual(writes[0][3], change.expectedRevisions)
  assert.equal(state.memory.changes[0].status, 'undone')
  assert.equal(state.memory.changeBusy, false)
  await actions.toggleMemoryChanges()
  assert.deepEqual(state.memory.changes, [])
})

test('a delayed dispute list cannot reopen a closed panel or overwrite a new opening', async () => {
  let state: State = reduce(initialState, { type: 'memory_open' })
  type Items = Awaited<ReturnType<AgentApi['listInvalidMemories']>>
  const requests: ((items: Items) => void)[] = []
  const api = {
    listInvalidMemories: () => new Promise<Items>(resolve => { requests.push(resolve) }),
    getMemory: async () => ({ items: [], total: 0 }),
  } as AgentApi
  const actions = createMemoryActions({
    api, getState: () => state, dispatch: action => { state = reduce(state, action) },
    showToast: () => {}, errorMessage: String, ask: () => false,
  })
  const first = actions.toggleInvalid()
  actions.closeProfile()
  actions.openProfile()
  const second = actions.toggleInvalid()
  requests[1]([{ id: 1, revision: 3, text: '现在有效的争议' }])
  await second
  requests[0]([{ id: 1, revision: 2, text: '旧争议' }])
  await first
  assert.equal(state.memory.invalidOpen, true)
  assert.equal(state.memory.invalidItems[0]?.revision, 3)
})

test('an unsafe undo shows the current records named by the backend and refreshes the history', async () => {
  const change: import('../src/shared/ipc-results.ts').MemoryChangeRecord = {
    id: 4, revision: 12, kind: 'supersede', status: 'applied', before: '旧值', after: '新值',
    scope: { kind: 'user' }, from: 1, to: null, createdAt: 1, effectiveAt: 1, evidence: [],
    expectedRevisions: [{ id: 7, revision: 12 }],
  }
  let state: State = initialState
  const toasts: string[] = []
  const api: Pick<AgentApi, 'getMemory' | 'listMemoryChanges' | 'undoMemoryChange'> = {
    getMemory: async () => ({ items: [], total: 0 }),
    listMemoryChanges: async () => [change],
    undoMemoryChange: async () => ({ status: 'conflict', current: [{ id: 7, revision: 15 }, { id: 9, revision: 15 }] }),
  }
  const actions = createMemoryActions({
    api: api as AgentApi, getState: () => state, dispatch: action => { state = reduce(state, action) },
    showToast: text => toasts.push(text), errorMessage: String, ask: () => false,
  })
  await actions.toggleMemoryChanges()
  await actions.undoMemoryChange(change)
  assert.match(state.memory.error ?? '', /#7, #9/)
  assert.equal(state.memory.changes[0]?.status, 'applied')
  assert.deepEqual(toasts, [])
})

test('index rebuild runs once at a time and reports success and incomplete resets', async () => {
  type Result = Awaited<ReturnType<AgentApi['rebuildMemoryIndexes']>>
  let state: State = initialState
  const requests: ((result: Result) => void)[] = []
  const toasts: string[] = []
  const api: Pick<AgentApi, 'rebuildMemoryIndexes'> = {
    rebuildMemoryIndexes: () => new Promise(resolve => { requests.push(resolve) }),
  }
  const actions = createMemoryActions({
    api: api as AgentApi, getState: () => state, dispatch: action => { state = reduce(state, action) },
    showToast: text => toasts.push(text), errorMessage: String, ask: () => false,
  })
  const first = actions.rebuildMemoryIndexes()
  assert.equal(state.memory.rebuildingIndexes, true)
  await actions.rebuildMemoryIndexes()
  assert.equal(requests.length, 1)
  requests[0]({ fullText: true, semantic: true })
  await first
  assert.equal(state.memory.rebuildingIndexes, false)
  assert.deepEqual(toasts, ['索引已开始重建，语义索引会在后台分批补齐。'])

  for (const [result, message] of [
    [{ fullText: true, semantic: false }, '全文索引已开始重建，语义索引暂时无法重置。'],
    [{ fullText: false, semantic: true }, '语义索引已开始后台重建，全文索引暂时无法重置。'],
    [{ fullText: false, semantic: false }, '无法启动记忆索引重建，请重试。'],
  ] as const) {
    const retry = actions.rebuildMemoryIndexes()
    requests.at(-1)!(result)
    await retry
    assert.equal(state.memory.rebuildingIndexes, false)
    assert.equal(toasts.at(-1), message)
  }
})
