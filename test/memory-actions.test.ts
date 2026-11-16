import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createMemoryActions, introChanges, introPrompt, memoryNotice } from '../src/renderer/memory-actions.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import { renderProfilePanel } from '../src/renderer/view/profile-panel.ts'
import type { MemoryFileDetailView } from '../src/shared/ipc-results.ts'

test('memory notices describe verified writes', () => {
  assert.equal(memoryNotice(['周报填写说明']), '已记住：周报填写说明')
  assert.equal(memoryNotice(['a', 'b']), '已记住 2 条新内容')
  assert.equal(memoryNotice(), '')
})

function profileDom(t: TestContext) {
  class Element {
    textContent = ''
    children: Element[] = []
    attrs: Record<string, string> = {}
    listeners: Record<string, () => unknown> = {}
    readonly tag: string
    constructor(tag: string) { this.tag = tag }
    setAttribute(name: string, value: string) { this.attrs[name] = value }
    addEventListener(name: string, listener: () => unknown) { this.listeners[name] = listener }
    append(child: Element) { this.children.push(child) }
    replaceChildren(...children: Element[]) { this.children = children }
    querySelector() { return null }
    querySelectorAll() { return [] }
    contains() { return false }
  }
  function flatten(element: Element): Element[] { return [element, ...element.children.flatMap(flatten)] }
  const globals = globalThis as unknown as Record<string, unknown>
  const before = Object.fromEntries(['Node', 'document', 'HTMLInputElement', 'HTMLTextAreaElement'].map(key => [key, globals[key]]))
  globals.Node = Element
  globals.HTMLInputElement = Element
  globals.HTMLTextAreaElement = Element
  globals.document = {
    createElement: (tag: string) => new Element(tag), createElementNS: (_ns: string, tag: string) => new Element(tag),
    createTextNode: (text: string) => Object.assign(new Element('#text'), { textContent: text }),
  }
  t.after(() => { Object.assign(globals, before) })
  return {
    draw(memory: State['memory'], handlers: Handlers) {
      const panel = new Element('root')
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

test('the intro saves only the profile fields and lists sites and documents in the reading prompt', () => {
  assert.deepEqual(introChanges({ role: ' 后端负责人 ', projects: '', preferences: '先给结论', sources: 'https://wiki.example', email: 'x' }),
    { role: '后端负责人', preferences: '先给结论' })
  assert.match(introPrompt({ sources: ['https://wiki.example'], docs: [{ path: '/w/我的资料/周报.md' }] }), /- https:\/\/wiki\.example\n- \/w\/我的资料\/周报\.md$/)
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
  requests[0]!({ fullText: false, semantic: false, files: { lexical: true, vectorGeneration: 1 } })
  await first
  assert.equal(state.memory.rebuildingIndexes, false)
  assert.deepEqual(toasts, ['已重建文件记忆的全文索引。'])

  const retry = actions.rebuildMemoryIndexes()
  requests[1]!({ fullText: false, semantic: false, files: { lexical: false, vectorGeneration: 2 } })
  await retry
  assert.equal(state.memory.rebuildingIndexes, false)
  assert.equal(toasts.at(-1), '无法启动记忆索引重建，请重试。')
})
