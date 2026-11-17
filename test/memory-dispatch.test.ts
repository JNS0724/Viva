import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryDispatch, MemoryDispatchConflict } from '../src/memory/core/memory-dispatch.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'

const fileReference = (revision: number) => ({ workspace: '0'.repeat(64), id: 'file', path: 'digest/wiki/report.md',
  revision: String(revision), usageVersion: 0, policyToken: 'policy', sourceRanges: [{ sourceId: 'file-source' }] })

test('file versions and raw sources invalidate just the sessions that used them, including forks', () => {
  const store = openMemoryStore(':memory:')
  try {
    let revision = 1
    let sourceAllowed = true
    const open = () => createMemoryDispatch(store, () => sourceAllowed, files => files.every(file => file.id === 'independent' || file.revision === String(revision)))
    const dispatch = open()
    dispatch.recordFiles('main', [fileReference(1)])
    dispatch.recordFiles('independent', [{ ...fileReference(2), id: 'independent' }])
    dispatch.recordSource('raw', 'source')
    dispatch.inherit('main', 'fork')
    dispatch.inherit('raw', 'derived')

    revision = 2
    const resumed = open()
    assert.equal(resumed.stale('main'), true)
    assert.equal(resumed.stale('fork'), true)
    assert.equal(resumed.stale('independent'), false)
    assert.equal(resumed.stale('unrelated'), false)
    assert.equal(resumed.stale('derived'), false)
    sourceAllowed = false
    assert.equal(resumed.stale('raw'), true)
    assert.equal(resumed.stale('derived'), true)
    assert.equal(resumed.stale('unrelated'), false)
  } finally {
    store.close()
  }
})

test('a clarification choice is scoped to its live turn even across forks and process restart', () => {
  const store = openMemoryStore(':memory:')
  try {
    const open = () => createMemoryDispatch(store, () => true)
    const dispatch = open()
    dispatch.recordTurnOnly('current')
    dispatch.inherit('current', 'fork')
    assert.equal(dispatch.stale('current'), false)
    assert.equal(dispatch.stale('fork'), true)
    assert.equal(dispatch.stale('unrelated'), false)
    assert.equal(open().stale('current'), true)
    dispatch.endTurn('current')
    assert.equal(dispatch.stale('current'), true)

    dispatch.recordTurnOnly('reset')
    dispatch.resetLive()
    assert.equal(dispatch.stale('reset'), true)
    assert.equal(dispatch.stale('unrelated'), false)
  } finally {
    store.close()
  }
})

test('a prospective commit waits only for requests that would carry affected file proof', async () => {
  const store = openMemoryStore(':memory:')
  try {
    let revision = 1
    const dispatch = createMemoryDispatch(store, () => true, files => files.every(file => file.revision === String(revision)))
    dispatch.recordFiles('affected', [fileReference(revision)])
    const affected = dispatch.admission('affected')
    const unrelated = dispatch.admission('unrelated')
    assert.ok(affected.allowed && unrelated.allowed)
    dispatch.acquireSession('slow-unrelated', 'unrelated', unrelated, () => true)
    dispatch.acquireSession('affected', 'affected', affected, () => true)
    revision = 2
    assert.throws(dispatch.validateCommit, error => error instanceof MemoryDispatchConflict && error.requests.join() === 'affected')
    const safe = dispatch.whenIdle(['affected'])
    dispatch.release('affected')
    await safe
    assert.doesNotThrow(dispatch.validateCommit)
    assert.equal(dispatch.canCommit(), false)
  } finally { store.close() }
})
