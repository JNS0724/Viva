import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { importCounts, importing } from '../src/renderer/import-flow-state.ts'
import type { ImportCandidateView } from '../src/renderer/capability-types.ts'

/** Bringing skills or MCP servers in (import-flow-state.ts): where from, what was found, what is ticked. */

const candidate = (entry: string, status: ImportCandidateView['status'], extra: Partial<ImportCandidateView> = {}): ImportCandidateView => ({
  entry, name: entry, status, picked: status !== 'blocked', why: status === 'ready' ? 'ready' : 'fields', detail: null, ...extra,
})
const sources = [{ id: 'claude-code', label: 'Claude Code', count: 3, where: '~/.claude/skills' }]
const scan = {
  scanId: 'scan-1', label: 'Claude Code',
  candidates: [candidate('weekly', 'ready'), candidate('notes', 'fixable', { why: 'name' }), candidate('git', 'fixable', { why: 'taken', picked: false }), candidate('broken', 'blocked')],
}
const opened = (kind: 'skills' | 'mcp' = 'skills') => reduce(initialState, { type: 'import_open', kind, sources })

test('opened on where from, for its kind; a scan ticks what it found ticked; back goes to where from again', () => {
  const skills = opened()
  assert.deepEqual([skills.importFlow.open, skills.importFlow.kind, skills.importFlow.sources, skills.importFlow.scan], [true, 'skills', sources, null])
  assert.deepEqual([importing(skills, 'skills'), importing(skills, 'mcp')], [true, false], 'shown on its own tab only')
  const scanned = reduce(reduce(skills, { type: 'import_busy' }), { type: 'import_scanned', scan })
  assert.deepEqual([scanned.importFlow.busy, scanned.importFlow.picks], [false, ['weekly', 'notes']])
  assert.equal(reduce(scanned, { type: 'import_back' }).importFlow.scan, null)
  assert.equal(reduce(scanned, { type: 'import_close' }).importFlow.open, false)
})

test('ticking and unticking; one that cannot go in cannot be ticked', () => {
  const scanned = reduce(opened('mcp'), { type: 'import_scanned', scan })
  const git = reduce(scanned, { type: 'import_pick', entry: 'git', on: true })
  assert.deepEqual(git.importFlow.picks, ['weekly', 'notes', 'git'])
  assert.deepEqual(reduce(git, { type: 'import_pick', entry: 'weekly', on: false }).importFlow.picks, ['notes', 'git'])
  assert.deepEqual(reduce(scanned, { type: 'import_pick', entry: 'broken', on: true }).importFlow.picks, ['weekly', 'notes'])
})

test('how many go in as they are, put right, or not at all; a failure says why and keeps what was found', () => {
  const scanned = reduce(opened(), { type: 'import_scanned', scan })
  assert.deepEqual(importCounts(scanned), { ready: 1, fixable: 2, blocked: 1, picked: 2 })
  const failed = reduce(reduce(scanned, { type: 'import_busy' }), { type: 'import_failed', message: '文件夹变了' })
  assert.deepEqual([failed.importFlow.busy, failed.importFlow.error, failed.importFlow.scan?.scanId], [false, '文件夹变了', 'scan-1'])
  assert.equal(reduce(failed, { type: 'import_failed', message: null }).importFlow.error, null, 'a dialog cancelled says nothing')
})

test('one picked, or another tab, leaves the import', () => {
  const scanned = reduce(opened(), { type: 'import_scanned', scan })
  assert.equal(reduce(scanned, { type: 'capabilities_select', id: 'user:weekly' }).importFlow.open, false)
  assert.equal(reduce(scanned, { type: 'capabilities_tab', tab: 'mcp' }).importFlow.open, false)
})
