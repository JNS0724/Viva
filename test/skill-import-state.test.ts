import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { importCounts } from '../src/renderer/skill-import-state.ts'
import type { SkillCandidateView } from '../src/renderer/capability-types.ts'

/** Bringing skills in (skill-import-state.ts): where from, what was found, what is ticked. */

const candidate = (entry: string, status: SkillCandidateView['status'], extra: Partial<SkillCandidateView> = {}): SkillCandidateView => ({
  entry, name: entry, description: '', status, issues: [], fix: null, picked: status !== 'blocked', ...extra,
})
const sources = [{ id: 'claude-code', label: 'Claude Code', count: 3, where: '~/.claude/skills' }]
const scan = {
  scanId: 'scan-1', label: 'Claude Code',
  candidates: [candidate('weekly', 'ready'), candidate('notes', 'fixable', { fix: 'name-format' }), candidate('git', 'fixable', { fix: 'taken', picked: false }), candidate('broken', 'blocked', { issues: ['fields'] })],
}

test('opened on where from; a scan ticks what it found ticked; back goes to where from again', () => {
  const opened = reduce(initialState, { type: 'skill_import_open', sources })
  assert.deepEqual([opened.skillImport.open, opened.skillImport.sources, opened.skillImport.scan], [true, sources, null])
  const scanned = reduce(reduce(opened, { type: 'skill_import_busy' }), { type: 'skill_import_scanned', scan })
  assert.deepEqual([scanned.skillImport.busy, scanned.skillImport.picks], [false, ['weekly', 'notes']])
  assert.equal(reduce(scanned, { type: 'skill_import_back' }).skillImport.scan, null)
  assert.equal(reduce(scanned, { type: 'skill_import_close' }).skillImport.open, false)
})

test('ticking and unticking; one dsh could not load cannot be ticked', () => {
  const scanned = reduce(reduce(initialState, { type: 'skill_import_open', sources }), { type: 'skill_import_scanned', scan })
  const git = reduce(scanned, { type: 'skill_import_pick', entry: 'git', on: true })
  assert.deepEqual(git.skillImport.picks, ['weekly', 'notes', 'git'])
  assert.deepEqual(reduce(git, { type: 'skill_import_pick', entry: 'weekly', on: false }).skillImport.picks, ['notes', 'git'])
  assert.deepEqual(reduce(scanned, { type: 'skill_import_pick', entry: 'broken', on: true }).skillImport.picks, ['weekly', 'notes'])
})

test('how many go in as they are, put right, or not at all; a failure says why and keeps what was found', () => {
  const scanned = reduce(reduce(initialState, { type: 'skill_import_open', sources }), { type: 'skill_import_scanned', scan })
  assert.deepEqual(importCounts(scanned), { ready: 1, fixable: 2, blocked: 1, picked: 2 })
  const failed = reduce(reduce(scanned, { type: 'skill_import_busy' }), { type: 'skill_import_failed', message: '文件夹变了' })
  assert.deepEqual([failed.skillImport.busy, failed.skillImport.error, failed.skillImport.scan?.scanId], [false, '文件夹变了', 'scan-1'])
  assert.equal(reduce(failed, { type: 'skill_import_failed', message: null }).skillImport.error, null, 'a dialog cancelled says nothing')
})

test('a skill picked, or another tab, leaves the import', () => {
  const scanned = reduce(reduce(initialState, { type: 'skill_import_open', sources }), { type: 'skill_import_scanned', scan })
  assert.equal(reduce(scanned, { type: 'capabilities_select', id: 'user:weekly' }).skillImport.open, false)
  assert.equal(reduce(scanned, { type: 'capabilities_tab', tab: 'mcp' }).skillImport.open, false)
})
