import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createMemoryActions, introChanges, introPrompt, memoryNotice } from '../src/renderer/memory-actions.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import { renderProfilePanel } from '../src/renderer/view/profile-panel.ts'
import type { MemoryFileDetailView } from '../src/shared/ipc-results.ts'

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

test('delete distinguishes stopping use and verified cleanup and refreshes the persistent status', async () => {
  const memory = { id: 7, revision: 3, text: '要删除的具体记忆' }
  const load = { profile: {}, items: [], total: 0, invalid: 0, onboarding: 'done', habits: { text: '', samples: 0 } }
  let state: State = reduce(reduce(initialState, { type: 'memory_open' }), { type: 'memory_loaded', data: {
    ...load, items: [memory], total: 1,
  } })
  const toasts: string[] = []
  let cleanupPending = 0
  const writes: Parameters<AgentApi['deleteMemory']>[] = []
  const api: Pick<AgentApi, 'deleteMemory' | 'getMemory' | 'listInvalidMemories'> = {
    deleteMemory: async (...args) => {
      writes.push(args)
      return { status: cleanupPending ? 'stopped' : 'cleared' }
    },
    getMemory: async () => ({ ...load, cleanupPending }),
    listInvalidMemories: async () => [],
  }
  const actions = createMemoryActions({
    api: api as AgentApi, getState: () => state, dispatch: action => { state = reduce(state, action) },
    showToast: message => { toasts.push(message) }, errorMessage: String, ask: () => false,
  })
  await actions.toggleInvalid()
  cleanupPending = 1
  await actions.deleteMemory(memory)
  assert.deepEqual(writes[0].slice(0, 2), [memory.id, memory.revision])
  assert.equal(state.memory.cleanupPending, 1)
  assert.deepEqual(state.memory.items, [])
  assert.deepEqual(state.memory.invalidItems, [])
  assert.equal(toasts[0], '已停止使用这条记忆，正在清理副本。')

  cleanupPending = 0
  await actions.loadMemory()
  assert.equal(state.memory.cleanupPending, 0)
  await actions.deleteMemory({ ...memory, id: 8 })
  assert.equal(toasts[1], 'Viva 中的记忆副本已删除')
})

test('a summary from an earlier load cannot replace the fallback after memory changes', async () => {
  let state: State = reduce(initialState, { type: 'memory_open' })
  const old = { user: { generated: true, items: [{ id: 1, text: '已撤回', source: null }] }, project: null }
  const fallback = { user: { generated: false, items: [{ id: 2, text: '目前有效', source: null }] }, project: null }
  const load = { profile: {}, items: [], total: 0, invalid: 0, onboarding: 'done', habits: { text: '', samples: 0 } }
  type Data = typeof load & { summaries: typeof old }
  const pending: Array<(data: Data) => void> = []
  const api: Pick<AgentApi, 'getMemory'> = { getMemory: () => new Promise<Data>(resolve => { pending.push(resolve) }) }
  const actions = createMemoryActions({
    api: api as AgentApi, getState: () => state, dispatch: action => { state = reduce(state, action) },
    showToast: () => {}, errorMessage: String, ask: () => false,
  })
  state = reduce(state, { type: 'memory_loaded', data: { ...load, summaries: old } })
  const stale = actions.loadMemory()
  actions.onMemoryChanged({})
  assert.equal(state.memory.summaries, null, 'stop presenting the invalid summary as soon as invalidation arrives')
  pending[1]({ ...load, summaries: fallback })
  await Promise.resolve()
  pending[0]({ ...load, summaries: old })
  await stale
  assert.deepEqual(state.memory.summaries, fallback)

  const closing = actions.loadMemory()
  actions.closeProfile()
  pending[2]({ ...load, summaries: fallback })
  await closing
  assert.equal(state.memory.summaries, null)
})

function profileDom(t: TestContext) {
  const frames: Array<() => void> = []
  class Element {
    textContent = ''
    children: Element[] = []
    attrs: Record<string, string> = {}
    listeners: Record<string, (event?: Partial<KeyboardEvent>) => unknown> = {}
    value = ''
    parent: Element | null = null
    readonly tag: string
    constructor(tag: string) { this.tag = tag }
    setAttribute(name: string, value: string) { this.attrs[name] = value }
    addEventListener(name: string, listener: (event?: Partial<KeyboardEvent>) => unknown) { this.listeners[name] = listener }
    append(child: Element) { child.parent = this; this.children.push(child) }
    replaceChildren(...children: Element[]) {
      for (const child of this.children) child.parent = null
      this.children = []
      for (const child of children) this.append(child)
    }
    get dataset() { return { memoryFileEditor: this.attrs['data-memory-file-editor'] } }
    get isConnected(): boolean { return this.tag === 'root' || Boolean(this.parent?.isConnected) }
    querySelector(selector: string): Element | null {
      return selector === '[data-memory-file-editor]' ? flatten(this).find(node => node.dataset.memoryFileEditor) ?? null : null
    }
    querySelectorAll() { return [] }
    contains() { return false }
  }
  function flatten(element: Element): Element[] { return [element, ...element.children.flatMap(flatten)] }
  const globals = globalThis as unknown as Record<string, unknown>
  const before = Object.fromEntries(['Node', 'document', 'HTMLInputElement', 'HTMLTextAreaElement', 'requestAnimationFrame'].map(key => [key, globals[key]]))
  globals.requestAnimationFrame = (callback: () => void) => frames.push(callback)
  globals.Node = Element
  globals.HTMLInputElement = Element
  globals.HTMLTextAreaElement = Element
  globals.document = {
    createElement: (tag: string) => new Element(tag), createElementNS: (_ns: string, tag: string) => new Element(tag),
    createTextNode: (text: string) => Object.assign(new Element('#text'), { textContent: text }),
  }
  t.after(() => { Object.assign(globals, before) })
  return {
    root: () => new Element('root'),
    flushFrames: () => { for (const callback of frames.splice(0)) callback() },
    draw(memory: State['memory'], handlers: Handlers, panel = new Element('root')) {
      renderProfilePanel(panel as unknown as HTMLElement, memory, handlers)
      return flatten(panel)
    },
    flatten,
  }
}

test('About You presents distinct summary scopes, fallback notice, and verified timeline navigation', t => {
  const { draw, flatten } = profileDom(t)
  const link = 'viva://timeline/segment-1/0/88'
  const summaries = {
    user: { generated: true, items: [{ id: 1, text: '长期工作方式', source: { text: '原始发言', link } }] },
    project: { generated: false, items: [{ id: 2, text: '<b>当前项目约束</b>', source: { text: null, link: 'javascript:bad()' } }] },
  }
  const loaded = reduce(reduce(initialState, { type: 'memory_open' }), { type: 'memory_loaded', data: {
    summaries, profile: {}, habits: { text: '', samples: 0 }, total: 0, items: [],
  } })
  const navigated: string[] = []
  const handlers = { closeProfile: () => { navigated.push('close') }, openLink: (url: string) => { navigated.push(url) } }
  const sections = draw(loaded.memory, handlers as Handlers).filter(node => node.attrs['data-profile-summary'])
  assert.deepEqual(sections.map(node => node.attrs['data-profile-summary']), ['user', 'project'])
  const user = flatten(sections[0]), project = flatten(sections[1])
  assert.ok(user.some(node => node.textContent === '原始发言'))
  assert.ok(!user.some(node => node.textContent.startsWith('摘要还没准备好')))
  assert.ok(project.some(node => node.textContent.startsWith('摘要还没准备好')))
  assert.ok(project.some(node => node.textContent === '<b>当前项目约束</b>'))
  assert.ok(!project.some(node => node.tag === 'button'))
  user.find(node => node.attrs['aria-label'] === '查看记忆 #1 的原文')?.listeners.click()
  assert.deepEqual(navigated, ['close', link])
})

test('a failed reopen of About You offers an operable retry even when file mode was loaded before', async t => {
  const { draw } = profileDom(t)
  const data = { fileMode: true, profile: {}, items: [], total: 0, onboarding: 'done', habits: { text: '', samples: 0 } }
  let rejectLoad = false, fileLists = 0, state: State = initialState
  const dispatch = (action: Action) => { state = reduce(state, action) }
  const api: Pick<AgentApi, 'getMemory' | 'listMemoryFiles'> = {
    getMemory: async () => { if (rejectLoad) throw new Error('Disconnected from owner'); return data },
    listMemoryFiles: async () => { fileLists++; return { status: 'ok', snapshot: 'snapshot', items: [], nextCursor: null } },
  }
  const actions = createMemoryActions({ api: api as AgentApi, getState: () => state, dispatch, errorMessage: String, showToast: () => {}, ask: () => false })
  dispatch({ type: 'memory_open' })
  assert.equal(await actions.loadMemory(), true)
  assert.equal(state.memory.files.loaded, true)
  actions.closeProfile()
  dispatch({ type: 'memory_open' })
  rejectLoad = true
  assert.equal(await actions.loadMemory(), false)
  assert.equal(state.memory.loaded, true, 'a previous capability load is cached')
  const failed = draw(state.memory, actions as Handlers)
  assert.ok(failed.some(node => node.attrs.role === 'alert' && node.textContent.includes('Disconnected from owner')))
  assert.ok(!failed.some(node => node.textContent === '正在加载记忆…'))
  const retry = failed.find(node => node.tag === 'button' && node.textContent === '重新加载')
  assert.ok(retry?.listeners.click)
  rejectLoad = false
  assert.equal(await retry.listeners.click(), true)
  assert.equal(state.memory.loadError, null)
  assert.equal(state.memory.files.loaded, true)
  assert.equal(fileLists, 2)
})

test('file details distinguish linked and unlocated sources without promoting the note text to evidence', t => {
  const { draw } = profileDom(t)
  const identity = { kind: 'daily' as const, id: 'note', workspace: 'workspace' }
  const selection = { identity }
  const link = 'viva://timeline/segment/0/88'
  const unknown = { namespace: 'canonical', sourceId: 'unlocated', revision: 1, link: null }
  const detail: MemoryFileDetailView = { identity, version: { contentRevision: 'body', usageVersion: 1, policyToken: 'policy' },
    title: '日记', path: 'daily/note.md', enabled: true, applicability: 'current', actions: { setEnabled: true, edit: false, forget: false, undo: null },
    markdown: '这是笔记内容。', sources: [{ ...unknown, sourceId: 'linked', link }, unknown],
  }
  let state = reduce(reduce(initialState, { type: 'memory_open' }), { type: 'memory_loaded', data: { fileMode: true, cleanupPending: 2, profile: {}, habits: { text: '', samples: 0 } } })
  state = reduce(state, { type: 'memory_file_select', selection })
  state = reduce(state, { type: 'memory_file_read', selection, detail })
  const links: string[] = []
  const handlers = { closeProfile: () => {}, openLink: (url: string) => { links.push(url) } } as Handlers
  let nodes = draw(state.memory, handlers)
  assert.ok(nodes.some(node => node.textContent === '部分原文尚未在本机定位。'))
  assert.ok(nodes.some(node => node.textContent === '记忆存储还有 2 项清理待处理。'))
  const source = nodes.find(node => node.tag === 'button' && node.textContent === '查看原文')
  assert.ok(source?.listeners.click)
  source.listeners.click()
  assert.deepEqual(links, [link])
  const archived = { ...selection, restrictionId: 'archive' }
  state = reduce(state, { type: 'memory_file_select', selection: archived })
  state = reduce(state, { type: 'memory_file_read', selection: archived, detail: { ...detail,
    stoppedSnapshot: { restrictionId: 'archive', markdown: '这是存档笔记。', sources: [unknown] } } })
  nodes = draw(state.memory, handlers)
  assert.ok(nodes.some(node => node.textContent === '原文尚未在本机定位。'))
  assert.ok(!nodes.some(node => node.tag === 'button' && node.textContent === '查看原文'))
})

test('file-backed profile opens the matching evidence by identity and clears obsolete project summaries', t => {
  const { draw, flatten } = profileDom(t)
  const identity = { kind: 'digest' as const, workspace: 'personal', id: 'file-a' }
  const project = { kind: 'digest' as const, workspace: 'project', id: 'file-b' }
  let state = reduce(reduce(initialState, { type: 'memory_open' }), { type: 'memory_loaded', data: {
    fileMode: true, profile: {}, habits: { text: '', samples: 0 }, fileProfile: {
      user: [{ identity, text: '长期工作方式' }], project: [{ identity: project, text: '项目范围内的记忆' }],
    },
  } })
  const selected: unknown[] = []
  const handlers = { showMemoryFile: (item: unknown) => { selected.push(item) } } as Handlers
  const sections = draw(state.memory, handlers).filter(node => node.attrs['data-profile-summary'])
  assert.deepEqual(sections.map(node => node.attrs['data-profile-summary']), ['user', 'project'])
  const projectNodes = flatten(sections[1])
  const button = projectNodes.find(node => node.tag === 'button' && node.textContent === '查看依据')!
  assert.ok(projectNodes.some(node => node.attrs.id === button.attrs['aria-describedby'] && node.textContent === '项目范围内的记忆'))
  button.listeners.click()
  assert.deepEqual(selected, [{ identity: project }])
  state = reduce(state, { type: 'memory_summaries_stale' })
  assert.ok(!draw(state.memory, handlers).some(node => node.attrs['data-profile-summary']))
})

test('the file editor keeps multiline submission and Escape separate from IME composition', t => {
  const { draw } = profileDom(t)
  let state = reduce(reduce(initialState, { type: 'memory_open' }), { type: 'memory_loaded',
    data: { fileMode: true, profile: {}, habits: { text: '', samples: 0 } } })
  state = reduce(state, { type: 'memory_file_editor', editor: { id: 3, kind: 'create', draft: { title: '', text: '' } } })
  state = reduce(state, { type: 'memory_load_failed', message: 'Owner still syncing' })
  const effects: unknown[] = []
  const handlers = {
    saveMemoryFileEditor: (id: number, draft: { title: string, text: string }) => effects.push({ id, ...draft }),
    cancelMemoryFileEditor: (id: number) => effects.push(id),
  } as unknown as Handlers
  const nodes = draw(state.memory, handlers)
  const form = nodes.find(node => node.tag === 'form')!
  assert.equal(form.attrs['data-memory-files-view'], 'create', 'a refresh failure leaves the active draft visible')
  nodes.find(node => node.attrs.name === 'memory-file-draft-title')!.value = '修订记录'
  nodes.find(node => node.attrs.name === 'memory-file-draft-text')!.value = '第一段\n第二段'
  const event = { preventDefault() {}, stopPropagation() {} }
  form.listeners.compositionstart()
  form.listeners.keydown({ ...event, key: 'Escape', isComposing: true })
  form.listeners.submit(event)
  form.listeners.compositionend()
  form.listeners.keydown({ ...event, key: 'Escape', keyCode: 229 })
  form.listeners.keydown({ ...event, key: 'Enter' })
  assert.deepEqual(effects, [], 'native multiline and IME handling does not submit or cancel the editor')
  form.listeners.submit(event)
  form.listeners.keydown({ ...event, key: 'Escape' })
  assert.deepEqual(effects, [{ id: 3, title: '修订记录', text: '第一段\n第二段' }, 3])
})

test('profile refresh waits for the active file editor IME composition and discards redraws from closed editors', t => {
  const { draw, flatten, flushFrames, root } = profileDom(t)
  const panel = root()
  const handlers = {} as Handlers
  let state = reduce(reduce(initialState, { type: 'memory_open' }), { type: 'memory_loaded',
    data: { fileMode: true, profile: {}, habits: { text: '', samples: 0 } } })
  state = reduce(state, { type: 'memory_file_editor', editor: { id: 1, kind: 'create', draft: { title: '', text: '' } } })
  const form = draw(state.memory, handlers, panel).find(node => node.tag === 'form')!
  form.listeners.compositionstart()
  state = reduce(state, { type: 'memory_files_invalidated' })
  assert.equal(draw(state.memory, handlers, panel).find(node => node.tag === 'form'), form)
  state = reduce(state, { type: 'memory_load_failed', message: 'Latest owner state' })
  assert.equal(draw(state.memory, handlers, panel).find(node => node.tag === 'form'), form)
  form.listeners.compositionend()
  assert.equal(flatten(panel).find(node => node.tag === 'form'), form, 'allow native input to finish before replacing the form')
  flushFrames()
  assert.ok(flatten(panel).some(node => node.textContent === 'Latest owner state'))
  const current = flatten(panel).find(node => node.tag === 'form')!
  assert.notEqual(current, form)
  current.listeners.compositionstart()
  draw(state.memory, handlers, panel)
  current.listeners.compositionend()
  state = reduce(state, { type: 'memory_close' })
  draw(state.memory, handlers, panel)
  flushFrames()
  assert.equal(panel.children.length, 0)
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
