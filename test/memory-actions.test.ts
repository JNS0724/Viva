import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createMemoryActions, introChanges, introPrompt } from '../src/renderer/memory-actions.ts'
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
  const data = { profile: {}, items: [], total: 0, onboarding: 'done', habits: { text: '', samples: 0 } }
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
  let state = reduce(reduce(initialState, { type: 'memory_open' }), { type: 'memory_loaded', data: { cleanupPending: 2, profile: {}, onboarding: 'done', habits: { text: '', samples: 0 } } })
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
    profile: {}, onboarding: 'done', habits: { text: '', samples: 0 }, fileProfile: {
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

test('file permanent forget buttons map through explicit confirmation and keep IME Enter and Escape inert', async t => {
  const { draw } = profileDom(t)
  const detail: MemoryFileDetailView = { identity: { kind: 'digest', workspace: 'personal', id: 'file' },
    version: { contentRevision: 'revision', usageVersion: 1, policyToken: 'policy' }, title: 'Private note',
    path: 'digest/wiki/private.md', enabled: true, applicability: 'current', markdown: 'Private body', sources: [],
    actions: { edit: false, setEnabled: false, forget: true, undo: null } }
  let state = reduce(reduce(initialState, { type: 'memory_open' }), { type: 'memory_loaded', data: {
    profile: {}, onboarding: 'done', habits: { text: '', samples: 0 },
    fileProfile: { user: [{ identity: detail.identity, text: 'Derived private profile' }], project: null },
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
  assert.equal(state.memory.fileProfile, null)
  nodes = draw(state.memory, handlers)
  assert.ok(nodes.some(node => node.attrs.role === 'status' && node.textContent.includes('清理仍在进行中')))
  assert.ok(!nodes.some(node => node.textContent.includes('Private body') || node.textContent.includes('无法撤销。') && node.attrs.role === 'status'))
  assert.ok(!nodes.some(node => node.attrs.name === 'memory-file-forget-confirm'))
})

test('the file editor keeps multiline submission and Escape separate from IME composition', t => {
  const { draw } = profileDom(t)
  let state = reduce(reduce(initialState, { type: 'memory_open' }), { type: 'memory_loaded',
    data: { profile: {}, onboarding: 'done', habits: { text: '', samples: 0 } } })
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
    data: { profile: {}, onboarding: 'done', habits: { text: '', samples: 0 } } })
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
  dispatch({ type: 'memory_loaded', data: { profile: {}, habits: { text: '', samples: 0 }, onboarding: 'done' } })
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

test('reopening Dream status collects a lost manual receipt before another click starts fresh', async t => {
  let state = reduce(initialState, { type: 'memory_open' })
  const dispatch = (action: Action) => { state = reduce(state, action) }
  const idle = { state: 'idle' as const, lastCheckResult: null, lastCheckedAt: null, lastProcessedAt: null }
  const operations: string[] = []
  const api = { getDreamStatus: async () => idle, async runDream(id: string) {
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
  assert.equal(operations.length, 3)
  assert.equal(operations[0], operations[1])
  assert.notEqual(operations[1], operations[2])
})
