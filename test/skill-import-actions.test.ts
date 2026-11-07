import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createSkillImportActions } from '../src/renderer/skill-import-actions.ts'

/** Bringing skills in (skill-import-actions.ts): the three calls, and what the window does with each answer. */

const sources = [{ id: 'claude-code', label: 'Claude Code', count: 1, where: '~/.claude/skills' }]
const scan = { scanId: 'scan-1', label: 'Claude Code', candidates: [{ entry: 'notes', name: 'meeting-notes', description: '', status: 'fixable' as const, issues: [], fix: 'name-format' as const, picked: true }] }

function setup(api: Record<string, (...args: any[]) => Promise<unknown>>) {
  let state: State = initialState
  const actions = createSkillImportActions({
    api: api as never,
    getState: () => state,
    dispatch: (action) => { state = reduce(state, action) },
    errorMessage: (err) => (err instanceof Error ? err.message : String(err)),
  })
  return { actions, state: () => state }
}

test('opened on the folders found; one scanned; those ticked imported, the list and what was done shown, the new one picked', async () => {
  const asked: unknown[][] = []
  const { actions, state } = setup({
    skillSources: async () => sources,
    scanSkills: async (from) => { asked.push(['scan', from]); return scan },
    importSkills: async (scanId, picks) => {
      asked.push(['import', scanId, picks])
      return { imported: ['meeting-notes'], failed: [], notice: '已导入 1 个技能：meeting-notes。', skills: [{ id: 'user:meeting-notes', name: 'meeting-notes', root: 'user', rootLabel: 'Viva' }] }
    },
  })
  await actions.openSkillImport()
  assert.deepEqual([state().skillImport.open, state().skillImport.sources], [true, sources])
  await actions.scanSkillSource('claude-code')
  assert.deepEqual(state().skillImport.picks, ['notes'])
  await actions.importPickedSkills()
  assert.deepEqual(asked, [['scan', 'claude-code'], ['import', 'scan-1', ['notes']]])
  assert.equal(state().skillImport.open, false)
  assert.deepEqual([state().extensions.notice, state().capabilities.selected], ['已导入 1 个技能：meeting-notes。', 'user:meeting-notes'])
})

test('the folder dialog cancelled says nothing; a scan or import that fails says why and stays', async () => {
  const cancelled = setup({ skillSources: async () => sources, scanSkills: async () => ({ cancelled: true }), importSkills: async () => ({}) })
  await cancelled.actions.openSkillImport()
  await cancelled.actions.scanSkillSource('choose')
  assert.deepEqual([cancelled.state().skillImport.busy, cancelled.state().skillImport.error, cancelled.state().skillImport.scan], [false, null, null])

  const failing = setup({ skillSources: async () => sources, scanSkills: async () => scan, importSkills: async () => { throw new Error('文件夹可能已经变了') } })
  await failing.actions.openSkillImport()
  await failing.actions.scanSkillSource('claude-code')
  await failing.actions.importPickedSkills()
  assert.deepEqual([failing.state().skillImport.open, failing.state().skillImport.error], [true, '文件夹可能已经变了'])
})

test('nothing ticked, nothing asked', async () => {
  let imports = 0
  const { actions } = setup({ skillSources: async () => sources, scanSkills: async () => ({ ...scan, candidates: [{ ...scan.candidates[0], picked: false }] }), importSkills: async () => { imports++; return {} } })
  await actions.openSkillImport()
  await actions.scanSkillSource('claude-code')
  await actions.importPickedSkills()
  assert.equal(imports, 0)
})
