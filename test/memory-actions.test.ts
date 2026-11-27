import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createMemoryActions } from '../src/renderer/memory-actions.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import { renderProfilePanel } from '../src/renderer/view/profile-panel.ts'
import type { MemoryFileDetailView } from '../src/shared/ipc-results.ts'

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

test('a failed reopen of About You offers an operable retry after a previous load', async t => {
  const { draw } = profileDom(t)
  const data = { cleanupPending: 0, revision: 0, residentProfile: null, habits: { text: '', samples: 0 } }
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
  dispatch({ type: 'memory_dream_status', status: { state: 'idle', lastCheckResult: null, lastCheckedAt: null, lastProcessedAt: null } })
  const failed = draw(state.memory, actions as Handlers)
  assert.ok(failed.some(node => node.attrs['data-dream-state'] === 'idle'))
  assert.ok(failed.some(node => node.attrs.name === 'memory-files-search'))
  assert.ok(failed.some(node => node.attrs.role === 'alert' && node.textContent.includes('Disconnected from owner')))
  assert.ok(!failed.some(node => node.textContent === '正在加载记忆…'))
  const retry = failed.find(node => node.tag === 'button' && node.textContent === '重新加载')
  assert.ok(retry?.listeners.click)
  rejectLoad = false
  assert.equal(await retry.listeners.click(), true)
  assert.equal(state.memory.loadError, null)
  assert.equal(state.memory.files.loaded, true)
  assert.equal(fileLists, 3)
})


test('resident profile is pinned at the top of the managed memory file list', t => {
  const { draw } = profileDom(t)
  const resident = { kind: 'digest' as const, workspace: 'personal', id: 'profile-id' }
  const other = { kind: 'digest' as const, workspace: 'personal', id: 'file-b' }
  let state = reduce(reduce(initialState, { type: 'memory_open' }), { type: 'memory_loaded', data: {
    cleanupPending: 0, residentProfile: resident, habits: { text: '', samples: 0 },
  } })
  state = reduce(state, {
    type: 'memory_files_listed',
    query: '',
    more: false,
    page: {
      status: 'ok',
      snapshot: 'snap',
      nextCursor: null,
      items: [
        { identity: other, title: 'Other Note', path: 'digest/personal/other.md', enabled: true, version: { contentRevision: 'r1', usageVersion: 1, policyToken: 'p1' }, actions: { edit: true, setEnabled: true, forget: true, undo: null } },
        { identity: resident, title: 'Personal Profile', path: 'digest/personal/profile.md', enabled: true, version: { contentRevision: 'r2', usageVersion: 1, policyToken: 'p2' }, actions: { edit: true, setEnabled: true, forget: true, undo: null } },
      ],
    },
  })
  const selected: unknown[] = []
  const handlers = { showMemoryFile: (item: unknown) => { selected.push(item) } } as Handlers
  const items = draw(state.memory, handlers).filter(node => node.attrs['data-memory-file'])
  assert.deepEqual(items.map(node => node.attrs['data-memory-file']), ['profile-id', 'file-b'])
  assert.equal(items[0]!.attrs['data-resident-profile'], 'true')
  const openBtn = items[0]!.children.flatMap(child => child.children).find(node => node.tag === 'button')!
  openBtn.listeners.click()
  assert.deepEqual(selected, [{ identity: resident }])
})

test('file permanent forget buttons map through explicit confirmation and keep IME Enter and Escape inert', async t => {
  const { draw } = profileDom(t)
  const detail: MemoryFileDetailView = { identity: { kind: 'digest', workspace: 'personal', id: 'file' },
    version: { contentRevision: 'revision', usageVersion: 1, policyToken: 'policy' }, title: 'Private note',
    path: 'digest/wiki/private.md', enabled: true, markdown: 'Private body', sources: [],
    actions: { edit: false, setEnabled: false, forget: true, undo: null } }
  let state = reduce(reduce(initialState, { type: 'memory_open' }), { type: 'memory_loaded', data: {
    cleanupPending: 0, residentProfile: null, habits: { text: '', samples: 0 },
  } })
  const requests: Parameters<AgentApi['forgetMemoryFile']>[0][] = []
  const api: Pick<AgentApi, 'readMemoryFile' | 'listMemoryFiles' | 'forgetMemoryFile'> = { readMemoryFile: async () => detail,
    listMemoryFiles: async () => ({ status: 'ok', snapshot: 'empty', nextCursor: null, items: [] }),
    forgetMemoryFile: async request => { requests.push(request); return { status: 'applied', cleanup: 'pending',
      receipt: { ...request, action: 'FORGET', contentRevision: detail.version.contentRevision, usageVersion: 2 } } },
  }
  const actions = createMemoryActions({ api: api as AgentApi, getState: () => state, dispatch: action => { state = reduce(state, action) },
    errorMessage: String, showToast: () => {}, ask: () => false })
  const handlers = actions as unknown as Handlers
  await actions.showMemoryFile({ identity: detail.identity })
  draw(state.memory, handlers).find(node => node.attrs.name === 'memory-file-forget')!.listeners.click()
  assert.equal(requests.length, 0)
  const id = state.memory.files.forget!.id
  let nodes = draw(state.memory, handlers)
  const confirm = nodes.find(node => node.attrs['data-memory-file-forget'] === String(id))!
  assert.ok(nodes.some(node => node.attrs.id === 'memory-file-forget-description' && node.textContent.includes('原聊天、已有的汇报和任务')))
  let suppressed = 0
  const key = (value: Partial<KeyboardEvent>) => confirm.listeners.keydown({ ...value,
    preventDefault() { suppressed++ }, stopPropagation() {} })
  key({ key: 'Enter', isComposing: true })
  key({ key: 'Escape', isComposing: true })
  key({ key: 'Enter', keyCode: 229 })
  key({ key: 'Escape', keyCode: 229 })
  assert.equal(requests.length, 0)
  assert.equal(state.memory.files.forget?.id, id)
  assert.equal(suppressed, 2)
  key({ key: 'Escape' })
  assert.equal((() => state.memory.files.forget)(), null)
  actions.askManagedMemoryForget(detail)
  nodes = draw(state.memory, handlers)
  await nodes.find(node => node.attrs.name === 'memory-file-forget-confirm')!.listeners.click()
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.identity, detail.identity)
  assert.equal(requests[0]!.version, detail.version)
  assert.equal(state.memory.files.forget?.phase, 'pending')
  nodes = draw(state.memory, handlers)
  assert.ok(nodes.some(node => node.attrs.role === 'status' && node.textContent.includes('清理仍在进行中')))
  assert.ok(!nodes.some(node => node.textContent.includes('Private body') || node.textContent.includes('无法撤销。') && node.attrs.role === 'status'))
  assert.ok(!nodes.some(node => node.attrs.name === 'memory-file-forget-confirm'))
})

test('the file editor keeps multiline submission and Escape separate from IME composition', t => {
  const { draw } = profileDom(t)
  let state = reduce(reduce(initialState, { type: 'memory_open' }), { type: 'memory_loaded',
    data: { cleanupPending: 0, residentProfile: null, habits: { text: '', samples: 0 } } })
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
    data: { cleanupPending: 0, residentProfile: null, habits: { text: '', samples: 0 } } })
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

test('index rebuild runs once at a time and reports scheduled work and incomplete resets', async () => {
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
  requests[0]!({ fullText: false, semantic: false, files: { lexical: true, vectorGeneration: 1 } })
  await first
  assert.equal(state.memory.rebuildingIndexes, false)
  assert.deepEqual(toasts, ['已开始重建索引，后台会补齐缺失的全文和语义索引。'])

  const retry = actions.rebuildMemoryIndexes()
  requests[1]!({ fullText: false, semantic: false, files: { lexical: false, vectorGeneration: 2 } })
  await retry
  assert.equal(state.memory.rebuildingIndexes, false)
  assert.equal(toasts.at(-1), '无法启动记忆索引重建，请重试。')
})

test('Dream ignores a stale status read after a manual request and coalesces rapid clicks', async t => {
  const { draw } = profileDom(t)
  let state = reduce(initialState, { type: 'memory_open' })
  const dispatch = (action: Action) => { state = reduce(state, action) }
  dispatch({ type: 'memory_loaded', data: { cleanupPending: 0, residentProfile: null, habits: { text: '', samples: 0 } } })
  const idle = { state: 'idle' as const, lastCheckResult: null, lastCheckedAt: null, lastProcessedAt: null }
  dispatch({ type: 'memory_dream_status', status: idle })
  let resolveRead!: (value: typeof idle) => void, resolveStart!: () => void, starts = 0
  const api = {
    getDreamStatus: () => new Promise<typeof idle>(resolve => { resolveRead = resolve }),
    async runDream(operationId: string) {
      assert.match(operationId, /^[0-9a-f-]{36}$/u)
      starts++
      await new Promise<void>(resolve => { resolveStart = resolve })
      return { ...idle, state: 'running' as const }
    },
  }
  const actions = createMemoryActions({ api: api as AgentApi, getState: () => state, dispatch, errorMessage: String, showToast() {}, ask: () => false })
  t.after(() => actions.watchDream(false))
  actions.watchDream(true)
  const submitted = actions.runDream()
  await actions.runDream()
  assert.equal(starts, 1)
  resolveStart()
  await submitted
  resolveRead(idle)
  await Promise.resolve()
  assert.equal(state.memory.dream?.state, 'running')
  const nodes = draw(state.memory, actions as Handlers)
  assert.ok(nodes.some(node => node.attrs['data-dream-state'] === 'running'))
  assert.ok(nodes.some(node => node.attrs.role === 'status' && node.textContent.includes('正在整理')))
  const unchanged = reduce(state, { type: 'memory_dream_status', status: state.memory.dream })
  assert.equal(unchanged, state)
})

test('reopening Dream only reads status and an explicit retry reuses the unconfirmed operation', async t => {
  let state = reduce(initialState, { type: 'memory_open' })
  const dispatch = (action: Action) => { state = reduce(state, action) }
  const idle = { state: 'idle' as const, lastCheckResult: null, lastCheckedAt: null, lastProcessedAt: null }
  const operations: string[] = []
  let reads = 0
  const api = { getDreamStatus: async () => { reads++; return idle }, async runDream(id: string) {
    operations.push(id)
    if (operations.length === 1) throw new Error('lost reply')
    return { ...idle, jobId: id, completedAt: 42 }
  } }
  const actions = createMemoryActions({ api: api as AgentApi, getState: () => state, dispatch, errorMessage: String, showToast() {}, ask: () => false })
  t.after(() => actions.watchDream(false))
  actions.watchDream(true)
  await new Promise<void>(resolve => setImmediate(resolve))
  await actions.runDream()
  actions.watchDream(false)
  actions.watchDream(true)
  await new Promise<void>(resolve => setImmediate(resolve))
  await actions.runDream()
  assert.equal(reads, 2)
  assert.equal(operations.length, 2)
  await actions.runDream()
  assert.equal(operations.length, 3)
  assert.equal(operations[0], operations[1])
  assert.notEqual(operations[1], operations[2])
})

test('passive confirmation of a joined Dream lets the next click start a fresh operation', async t => {
  let state = reduce(initialState, { type: 'memory_open' })
  const dispatch = (action: Action) => { state = reduce(state, action) }
  const idle = { state: 'idle' as const, lastCheckResult: null, lastCheckedAt: null, lastProcessedAt: null }
  const operations: string[] = []
  const api = {
    async getDreamStatus(id?: string) {
      if (!id) return idle
      assert.equal(id, operations[0])
      return { ...idle, jobId: 'already-accepted-job' }
    },
    async runDream(id: string) {
      operations.push(id)
      if (operations.length === 1) throw new Error('lost after acceptance')
      return idle
    },
  }
  const actions = createMemoryActions({ api: api as AgentApi, getState: () => state, dispatch, errorMessage: String, showToast() {}, ask: () => false })
  t.after(() => actions.watchDream(false))
  actions.watchDream(true)
  await new Promise<void>(resolve => setImmediate(resolve))
  await actions.runDream()
  actions.watchDream(false)
  actions.watchDream(true)
  await new Promise<void>(resolve => setImmediate(resolve))
  await actions.runDream()
  assert.equal(operations.length, 2)
  assert.notEqual(operations[0], operations[1])
})

test('onMemoryChanged skips background IPC while closed and hub_close prevents in-flight retries', async () => {
  let state: State = initialState
  const dispatch = (action: Action) => { state = reduce(state, action) }
  const openStatesOnCall: boolean[] = []
  let pendingCall: ((data: Awaited<ReturnType<AgentApi['getMemory']>>) => void) | undefined
  let fileLists = 0
  const toasts: string[] = []
  const api: Pick<AgentApi, 'getMemory' | 'listMemoryFiles'> = {
    getMemory: () => {
      openStatesOnCall.push(state.memory.open)
      if (openStatesOnCall.length <= 2) {
        return new Promise(resolve => { pendingCall = resolve })
      }
      return Promise.resolve({
        cleanupPending: 0,
        revision: openStatesOnCall.length,
        residentProfile: null,
        habits: { text: '9–12 点', samples: openStatesOnCall.length },
      })
    },
    listMemoryFiles: async () => {
      fileLists++
      return { status: 'ok', snapshot: `s-${fileLists}`, items: [], nextCursor: null }
    },
  }
  const actions = createMemoryActions({
    api: api as AgentApi,
    getState: () => state,
    dispatch,
    errorMessage: String,
    showToast: msg => { toasts.push(msg) },
    ask: () => false,
  })

  // 1) Closed panel: background change fires zero RPCs while surfacing failure toasts
  actions.onMemoryChanged({ failure: '整理失败提示' })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(openStatesOnCall.length, 0)
  assert.equal(fileLists, 0)
  assert.deepEqual(toasts, ['整理失败提示'])

  // 2) Open starts in-flight call #1, user presses Esc (hub_close), two memory_changed events arrive, then #1 settles:
  //    no closed-panel retry RPCs may fire
  actions.openProfile()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(openStatesOnCall.length, 1)
  dispatch({ type: 'hub_close' })
  assert.equal(state.memory.open, false)
  actions.onMemoryChanged({})
  actions.onMemoryChanged({})
  pendingCall?.({ cleanupPending: 1, revision: 99, residentProfile: null, habits: { text: 'stale', samples: 9 } })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(openStatesOnCall, [true])

  // 3) Reverse order: open starts call #2, memory_changed arrives while open (bumping generation), then user presses Esc
  //    before call #2 settles: settling call #2 while closed still fires zero closed-panel retries, and reopening loads fresh
  actions.openProfile()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(openStatesOnCall.length, 2)
  actions.onMemoryChanged({})
  dispatch({ type: 'hub_close' })
  pendingCall?.({ cleanupPending: 1, revision: 100, residentProfile: null, habits: { text: 'stale-2', samples: 10 } })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(openStatesOnCall, [true, true])

  actions.openProfile()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(openStatesOnCall, [true, true, true])
  assert.equal(state.memory.habits.samples, 3)
})
