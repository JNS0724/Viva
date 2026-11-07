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
/** An import opened on `kind`, where from read; its generation with it. */
function opened(kind: 'skills' | 'mcp' = 'skills', from: State = initialState) {
  const opening = reduce(from, { type: 'import_opening', kind })
  const flow = opening.importFlow.flow
  return { state: reduce(opening, { type: 'import_sources', flow, sources }), flow }
}

test('opened on where from, for its kind; a scan ticks what it found ticked; back goes to where from again', () => {
  const { state: skills, flow } = opened()
  assert.deepEqual([skills.importFlow.open, skills.importFlow.kind, skills.importFlow.sources, skills.importFlow.scan, skills.importFlow.busy], [true, 'skills', sources, null, false])
  assert.deepEqual([importing(skills, 'skills'), importing(skills, 'mcp')], [true, false], 'shown on its own tab only')
  const scanned = reduce(reduce(skills, { type: 'import_busy', flow }), { type: 'import_scanned', flow, scan })
  assert.deepEqual([scanned.importFlow.busy, scanned.importFlow.picks], [false, ['weekly', 'notes']])
  assert.equal(reduce(scanned, { type: 'import_back' }).importFlow.scan, null)
  assert.equal(reduce(scanned, { type: 'import_close' }).importFlow.open, false)
})

test('ticking and unticking; one that cannot go in cannot be ticked', () => {
  const { state, flow } = opened('mcp')
  const scanned = reduce(state, { type: 'import_scanned', flow, scan })
  const git = reduce(scanned, { type: 'import_pick', entry: 'git', on: true })
  assert.deepEqual(git.importFlow.picks, ['weekly', 'notes', 'git'])
  assert.deepEqual(reduce(git, { type: 'import_pick', entry: 'weekly', on: false }).importFlow.picks, ['notes', 'git'])
  assert.deepEqual(reduce(scanned, { type: 'import_pick', entry: 'broken', on: true }).importFlow.picks, ['weekly', 'notes'])
})

test('how many go in as they are, put right, or not at all; a failure says why and keeps what was found', () => {
  const { state, flow } = opened()
  const scanned = reduce(state, { type: 'import_scanned', flow, scan })
  assert.deepEqual(importCounts(scanned), { ready: 1, fixable: 2, blocked: 1, picked: 2 })
  const failed = reduce(reduce(scanned, { type: 'import_busy', flow }), { type: 'import_failed', flow, message: '文件夹变了' })
  assert.deepEqual([failed.importFlow.busy, failed.importFlow.error, failed.importFlow.scan?.scanId], [false, '文件夹变了', 'scan-1'])
  assert.equal(reduce(failed, { type: 'import_failed', flow, message: null }).importFlow.error, null, 'a dialog cancelled says nothing')
})

test('one picked, or another tab, leaves the import', () => {
  const { state, flow } = opened()
  const scanned = reduce(state, { type: 'import_scanned', flow, scan })
  assert.equal(reduce(scanned, { type: 'capabilities_select', id: 'user:weekly' }).importFlow.open, false)
  assert.equal(reduce(scanned, { type: 'capabilities_tab', tab: 'mcp' }).importFlow.open, false)
})

test('an answer from an import closed or replaced since is let go: it never shows in the one open now', () => {
  const skills = opened('skills')
  const mcp = opened('mcp', skills.state)
  assert.ok(mcp.flow > skills.flow)
  const late = reduce(mcp.state, { type: 'import_scanned', flow: skills.flow, scan })
  assert.deepEqual([late.importFlow.kind, late.importFlow.scan], ['mcp', null], "the skills' scan does not land in the MCP import")
  assert.equal(reduce(mcp.state, { type: 'import_failed', flow: skills.flow, message: 'x' }).importFlow.error, null)
  assert.deepEqual(reduce(mcp.state, { type: 'import_sources', flow: skills.flow, sources: [] }).importFlow.sources, sources)
  const closed = reduce(mcp.state, { type: 'import_close' })
  assert.equal(reduce(closed, { type: 'import_scanned', flow: mcp.flow, scan }).importFlow.open, false, 'closed, it stays closed')
  assert.ok(opened('skills', closed).flow > mcp.flow, 'generations keep counting after a close')
})
