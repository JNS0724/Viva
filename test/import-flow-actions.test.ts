import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createImportFlowActions } from '../src/renderer/import-flow-actions.ts'

/** Bringing skills or MCP servers in (import-flow-actions.ts): the kind's calls, and what the window does with each answer. */

const sources = [{ id: 'claude-code', label: 'Claude Code', count: 1, where: '~/.claude/skills' }]
const scan = { scanId: 'scan-1', label: 'Claude Code', candidates: [{ entry: 'notes', name: 'meeting-notes', status: 'fixable' as const, picked: true, why: 'name', detail: null }] }

function setup(api: Record<string, (...args: any[]) => Promise<unknown>>, start: State = initialState) {
  let state: State = start
  const dispatch = (action: Action) => { state = reduce(state, action) }
  const actions = createImportFlowActions({
    api: api as never,
    getState: () => state,
    dispatch,
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  })
  return { actions, state: () => state, dispatch }
}

test('skills: opened on the folders found; one scanned; those ticked imported, the list and what was done shown, the new one picked', async () => {
  const asked: unknown[][] = []
  const { actions, state } = setup({
    skillSources: async () => sources,
    scanSkills: async (from) => { asked.push(['scan', from]); return scan },
    importSkills: async (scanId, picks) => {
      asked.push(['import', scanId, picks])
      return { imported: ['meeting-notes'], failed: [], notice: '已导入 1 个技能：meeting-notes。', skills: [{ id: 'user:meeting-notes', name: 'meeting-notes', root: 'user', rootLabel: 'Viva' }] }
    },
  })
  await actions.openImport('skills')
  assert.deepEqual([state().importFlow.kind, state().importFlow.sources], ['skills', sources])
  await actions.scanImportSource('claude-code')
  assert.deepEqual(state().importFlow.picks, ['notes'])
  await actions.importPicked()
  assert.deepEqual(asked, [['scan', 'claude-code'], ['import', 'scan-1', ['notes']]])
  assert.equal(state().importFlow.open, false)
  assert.deepEqual([state().extensions.notice, state().capabilities.selected], ['已导入 1 个技能：meeting-notes。', 'user:meeting-notes'])
})

test('MCP: the same flow with its own calls; the servers come back, the agent\'s word on them is kept, the first one picked', async () => {
  const mcpScan = { scanId: 'scan-9', label: 'Cursor', candidates: [{ entry: 'github', name: 'github', status: 'ready' as const, picked: true, why: 'ready', detail: null }] }
  const { actions, state } = setup({
    mcpSources: async () => [{ id: 'cursor', label: 'Cursor', count: 1, where: '~/.cursor/mcp.json' }],
    scanMcp: async () => mcpScan,
    importMcp: async () => ({ imported: ['github'], notice: '已导入 1 个 MCP 服务器：github。', info: { mode: 'live' }, servers: [{ name: 'github', type: 'stdio', args: [], envNames: [], headerNames: [] }] }),
  })
  await actions.openImport('mcp')
  await actions.scanImportSource('cursor')
  await actions.importPicked()
  const now = state()
  assert.deepEqual([now.importFlow.open, (now.extensions.servers as Array<{ name: string }>).map((server) => server.name), now.info.mode, now.capabilities.selected], [false, ['github'], 'live', 'github'])
})

test('MCP while the agent works: refused with why, nothing asked', async () => {
  let imports = 0
  const working = { ...initialState, phase: 'working' } as State
  const { actions, state } = setup({
    mcpSources: async () => [], scanMcp: async () => ({ ...scan, candidates: [{ ...scan.candidates[0], status: 'ready' as const }] }),
    importMcp: async () => { imports++; return {} },
  }, working)
  await actions.openImport('mcp')
  await actions.scanImportSource('cursor')
  await actions.importPicked()
  assert.deepEqual([imports, Boolean(state().importFlow.error)], [0, true])
})

test('the folder dialog cancelled says nothing; a scan or import that fails says why and stays', async () => {
  const cancelled = setup({ skillSources: async () => sources, scanSkills: async () => ({ cancelled: true }), importSkills: async () => ({}) })
  await cancelled.actions.openImport('skills')
  await cancelled.actions.scanImportSource('choose')
  assert.deepEqual([cancelled.state().importFlow.busy, cancelled.state().importFlow.error, cancelled.state().importFlow.scan], [false, null, null])

  const failing = setup({ skillSources: async () => sources, scanSkills: async () => scan, importSkills: async () => { throw new Error('文件夹可能已经变了') } })
  await failing.actions.openImport('skills')
  await failing.actions.scanImportSource('claude-code')
  await failing.actions.importPicked()
  assert.deepEqual([failing.state().importFlow.open, failing.state().importFlow.error], [true, '文件夹可能已经变了'])
})

test('nothing ticked, nothing asked; changed since shown: shown again with why, nothing taken as done', async () => {
  let imports = 0
  const none = setup({ skillSources: async () => sources, scanSkills: async () => ({ ...scan, candidates: [{ ...scan.candidates[0], picked: false }] }), importSkills: async () => { imports++; return {} } })
  await none.actions.openImport('skills')
  await none.actions.scanImportSource('claude-code')
  await none.actions.importPicked()
  assert.equal(imports, 0)

  const fresh = { scanId: 'scan-2', label: 'Claude Code', candidates: [{ ...scan.candidates[0], name: 'meeting-notes-2', why: 'taken', picked: false }] }
  const changed = setup({ skillSources: async () => sources, scanSkills: async () => scan, importSkills: async () => ({ changed: true, scan: fresh }) })
  await changed.actions.openImport('skills')
  await changed.actions.scanImportSource('claude-code')
  await changed.actions.importPicked()
  const now = changed.state().importFlow
  assert.deepEqual([now.open, now.scan?.scanId, now.picks, Boolean(now.error)], [true, 'scan-2', [], true])
  assert.equal(changed.state().extensions.notice, null)
})

test('a skills scan answering after an MCP import was opened is let go; the MCP import is left as it was', async () => {
  let answer: (value: unknown) => void = () => {}
  const { actions, state } = setup({
    skillSources: async () => sources,
    scanSkills: () => new Promise((resolve) => { answer = resolve }),
    mcpSources: async () => [{ id: 'cursor', label: 'Cursor', count: 1, where: '~/.cursor/mcp.json' }],
  })
  await actions.openImport('skills')
  const scanning = actions.scanImportSource('claude-code')
  await actions.openImport('mcp')
  answer(scan)
  await scanning
  const now = state().importFlow
  assert.deepEqual([now.kind, now.scan, now.busy, now.sources.map((source) => source.id)], ['mcp', null, false, ['cursor']])
})

test('an import answering after its flow was closed still lists what came in, but picks nothing and closes nothing', async () => {
  let answer: (value: unknown) => void = () => {}
  const { actions, state } = setup({
    skillSources: async () => sources,
    scanSkills: async () => scan,
    importSkills: () => new Promise((resolve) => { answer = resolve }),
  })
  await actions.openImport('skills')
  await actions.scanImportSource('claude-code')
  const importing = actions.importPicked()
  actions.closeImport()
  await actions.openImport('skills')
  answer({ imported: ['meeting-notes'], failed: [], notice: '已导入', skills: [{ id: 'user:meeting-notes', name: 'meeting-notes', root: 'user', rootLabel: 'Viva' }] })
  await importing
  assert.deepEqual([state().importFlow.open, state().capabilities.selected, (state().extensions.skills as Array<{ name: string }>).map((skill) => skill.name)], [true, null, ['meeting-notes']])
})

test('through the page: a skills scan still out, the tab switched to MCP and its import opened; the scan answering is let go', async () => {
  let answer: (value: unknown) => void = () => {}
  const { actions, state, dispatch } = setup({
    skillSources: async () => sources,
    scanSkills: () => new Promise((resolve) => { answer = resolve }),
    mcpSources: async () => [{ id: 'cursor', label: 'Cursor', count: 1, where: '~/.cursor/mcp.json' }],
  }, reduce(initialState, { type: 'capabilities_open', tab: 'skills' }))
  await actions.openImport('skills')
  const scanning = actions.scanImportSource('claude-code')
  dispatch({ type: 'capabilities_tab', tab: 'mcp' })
  await actions.openImport('mcp')
  answer(scan)
  await scanning
  assert.deepEqual([state().capabilities.tab, state().importFlow.kind, state().importFlow.scan, state().importFlow.busy], ['mcp', 'mcp', null, false])
})
