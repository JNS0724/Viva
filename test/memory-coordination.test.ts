import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryCoordination, MemoryCoordinationError } from '../src/memory/core/coordination.ts'
import type { MemoryCoordinationDispatch, MemoryCoordinationRuntime, MemoryProject } from '../src/memory/core/coordination.ts'
import { createMemoryDispatch, MemoryDispatchConflict } from '../src/memory/core/memory-dispatch.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'

function setup() {
  const store = openMemoryStore(':memory:')
  let valid = true
  let runtimeBusy = false
  let provisional = true
  let deadline: number | undefined
  let activeProject: MemoryProject | undefined = { kind: 'project', id: 'project-a' }
  const projects = new Map<string, string>()
  const runtime: MemoryCoordinationRuntime = {
    busy: () => runtimeBusy,
    sourceCurrent: () => valid,
    allowedHistory: () => valid,
    staleSession: () => false,
    sessionProject: session => projects.get(session),
    recordSessionProject: (session, project) => { projects.set(session, project) },
    projectAllows: (evidence, project) => !evidence.projects?.some(id => id !== project?.id),
    provisionalReadsCurrent: () => provisional,
    provisionalDeadline: () => deadline,
    computeAdmission: () => ({ current: () => valid, deadline: 250 }),
  }
  let owner: MemoryCoordinationRuntime | undefined = runtime
  const dispatch = createMemoryDispatch(store, () => valid, () => valid)
  let dispatcher: MemoryCoordinationDispatch = dispatch
  const coordinator = createMemoryCoordination({ runtime: () => owner, dispatch: () => dispatcher, now: () => 100 })
  return { store, dispatch, coordinator, runtime,
    project: () => activeProject,
    setProject: (project: MemoryProject | undefined) => { activeProject = project },
    setValid: (value: boolean) => { valid = value },
    setRuntimeBusy: (value: boolean) => { runtimeBusy = value },
    setProvisional: (value: boolean) => { provisional = value },
    setDeadline: (value: number | undefined) => { deadline = value },
    setOwner: (value: MemoryCoordinationRuntime | undefined) => { owner = value },
    setDispatch: (value: MemoryCoordinationDispatch) => { dispatcher = value },
  }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('mutation waits for affected dispatch, rejects concurrent mutation, and releases exclusion after retry', async () => {
  const fixture = setup()
  const { coordinator, dispatch, store } = fixture
  try {
    assert.ok(coordinator.beginSession('request', 'affected', fixture.project(), fixture.project))
    let attempts = 0
    const mutation = coordinator.mutate(() => {
      attempts++
      if (attempts === 1) throw new MemoryDispatchConflict(['request'])
      return 'committed'
    })
    await tick()
    assert.equal(coordinator.busy(), true)
    assert.equal(coordinator.beginSession('blocked', 'affected', fixture.project(), fixture.project), false)
    assert.equal(coordinator.beginJob('job-request', 'job'), false)
    // A mutation only fences sessions explicitly identified by a rolled-back write.
    assert.ok(coordinator.beginSession('other-request', 'unrelated', fixture.project(), fixture.project))
    await assert.rejects(coordinator.mutate(() => 'second'), MemoryCoordinationError)
    coordinator.endDispatch('request')
    assert.equal(await mutation, 'committed')
    assert.equal(attempts, 2)
    assert.equal(coordinator.busy(), false)
    coordinator.endDispatch('other-request')
    assert.equal(dispatch.canCommit(), true)
  } finally { store.close() }
})

test('failed host preparation and failed writes release mutation ownership without retrying ordinary errors', async () => {
  const { coordinator, store } = setup()
  try {
    let writes = 0
    await assert.rejects(coordinator.mutate(() => { writes++; return true }, () => { throw new Error('transport did not stop') }), /transport did not stop/)
    assert.equal(writes, 0)
    assert.equal(coordinator.busy(), false)
    await assert.rejects(coordinator.mutate(() => { writes++; throw new Error('disk failure') }), /disk failure/)
    assert.equal(writes, 1)
    assert.equal(coordinator.busy(), false)
    assert.equal(await coordinator.mutate(() => 'next'), 'next')
  } finally { store.close() }
})

test('project binding and provisional dependencies constrain admission and outstanding leases', () => {
  const fixture = setup()
  const { coordinator, dispatch, store } = fixture
  try {
    fixture.setDeadline(150)
    assert.deepEqual(coordinator.beginSession('request', 'session', fixture.project(), fixture.project), { allowed: true, deadline: 150 })
    assert.equal(coordinator.bindProject('session', { kind: 'project', id: 'other' }), false)
    fixture.setProject({ kind: 'project', id: 'other' })
    assert.equal(coordinator.stale('session', fixture.project()), true)
    assert.throws(dispatch.validateCommit, MemoryDispatchConflict)
    coordinator.endDispatch('request')
    fixture.setProvisional(false)
    assert.equal(coordinator.beginSession('next', 'new-session', fixture.project(), fixture.project), false)
  } finally { store.close() }
})

test('recovered source dependencies still reject model and cross-project transfer paths', () => {
  const fixture = setup()
  const { coordinator, dispatch, store } = fixture
  try {
    dispatch.recordSource('saved', 'original')
    const evidence = dispatch.snapshot('saved')
    assert.equal(coordinator.canTransferToModel('saved', false), false)
    assert.equal(coordinator.allowsTransport('saved', fixture.project(), false, true), false)
    assert.equal(coordinator.transfer('target', evidence, fixture.project(), false), false)
    assert.equal(coordinator.transfer('target', { ...evidence, projects: ['other'] }, fixture.project(), true), false)
    assert.equal(coordinator.transfer('target', evidence, fixture.project(), true), true)
    assert.deepEqual(dispatch.snapshot('target').sources, ['original'])
    fixture.setValid(false)
    const resumed = createMemoryDispatch(store, () => true, () => false)
    const restarted = createMemoryCoordination({ runtime: () => fixture.runtime, dispatch: () => resumed })
    assert.equal(restarted.allowsSession('target', fixture.project()), false)
    assert.equal(restarted.beginSession('replay', 'target', fixture.project(), fixture.project), false)
    assert.equal(restarted.transfer('next', evidence, fixture.project(), true), false)
  } finally { store.close() }
})

test('background leases cannot survive owner replacement or invalid dependencies', () => {
  const fixture = setup()
  const { coordinator, dispatch, store } = fixture
  try {
    fixture.setRuntimeBusy(true)
    assert.equal(coordinator.beginJob('request', 'job'), false)
    fixture.setRuntimeBusy(false)
    assert.deepEqual(coordinator.beginJob('request', 'job'), { allowed: true, deadline: 250 })
    fixture.setOwner(undefined)
    assert.throws(dispatch.validateCommit, MemoryDispatchConflict)
    coordinator.endDispatch('request')
    assert.equal(coordinator.beginJob('next', 'job'), false)
    assert.equal(coordinator.allowsSession('session', fixture.project()), false)
    fixture.setOwner(fixture.runtime)
    assert.ok(coordinator.beginJob('restored', 'job'))
    fixture.setValid(false)
    assert.throws(dispatch.validateCommit, MemoryDispatchConflict)
    coordinator.endDispatch('restored')
  } finally { store.close() }
})

test('history preserves genuine sources but checks derived session dependencies and target scope', () => {
  const fixture = setup()
  const { coordinator, dispatch, store } = fixture
  try {
    const project = fixture.project()
    coordinator.bindProject('original-session', project)
    dispatch.recordSource('original-session', 'original-source')
    const user = { segmentId: 'conversation', role: 'user', text: 'original text', sourceId: 'original-source', sessionId: 'original-session' }
    const assistant = { ...user, role: 'assistant', sourceId: null }
    assert.equal(coordinator.allowsProjectHistory(user, project, project), true)
    assert.equal(coordinator.allowsProjectHistory(user, project, { kind: 'project', id: 'other' }), false)
    const moved = { kind: 'project' as const, id: 'other' }
    assert.equal(coordinator.allowsProjectHistory(assistant, project, project, moved), false)
    // Independent user evidence remains readable when the derived session itself has moved.
    assert.equal(coordinator.allowsProjectHistory(user, project, project, moved), true)
    coordinator.useHistory('target', assistant)
    assert.deepEqual(dispatch.snapshot('target').sources, ['original-source'])
    fixture.setValid(false)
    assert.equal(coordinator.allowsProjectHistory(user, project, project), false)
    assert.equal(coordinator.allowsProjectHistory(assistant, project, project), false)
  } finally { store.close() }
})

test('in-turn inherited context and durable task payloads keep distinct transfer rules', () => {
  const fixture = setup()
  const { coordinator, dispatch, store } = fixture
  try {
    const project = fixture.project()
    dispatch.recordTurnOnly('live')
    assert.equal(coordinator.canInherit('live', project, project, true), true)
    assert.equal(coordinator.inherit('live', 'target', project, project, true), true)
    assert.equal(dispatch.snapshot('target').turnOnly, true)
    assert.equal(coordinator.transferStatus(dispatch.snapshot('live'), project, true), 'stale')
    dispatch.endTurn('live')
    assert.equal(coordinator.canInherit('live', project, project, true), false)
    dispatch.recordSource('saved', 'original')
    assert.equal(coordinator.transferStatus(dispatch.snapshot('saved'), project, false), 'memory-unavailable')
    assert.equal(coordinator.transferStatus(dispatch.snapshot('saved'), project, true), 'ready')
  } finally { store.close() }
})


test('late completion releases the original dispatcher and mutation waits for that old lease', async () => {
  const fixture = setup()
  const { coordinator, dispatch: original, store } = fixture
  const replacementStore = openMemoryStore(':memory:')
  const replacement = createMemoryDispatch(replacementStore, () => true, () => true)
  try {
    assert.ok(coordinator.beginSession('old-request', 'source', fixture.project(), fixture.project))
    fixture.setDispatch(replacement)
    fixture.setOwner({ ...fixture.runtime })
    assert.throws(original.validateCommit, MemoryDispatchConflict)
    assert.equal(coordinator.beginJob('old-request', 'job'), false)
    assert.equal(coordinator.beginSession('old-request', 'source', fixture.project(), fixture.project), false)
    assert.ok(coordinator.beginJob('new-request', 'job'))
    let attempts = 0
    const change = coordinator.mutate(() => {
      attempts++
      original.validateCommit()
      return 'committed'
    })
    await tick()
    assert.equal(attempts, 1)
    assert.equal(original.canCommit(), false)
    coordinator.endDispatch('old-request')
    assert.equal(await change, 'committed')
    assert.equal(original.canCommit(), true)
    assert.equal(replacement.canCommit(), false)
    // Duplicate late acknowledgment must not release an unrelated replacement request.
    coordinator.endDispatch('old-request')
    assert.equal(replacement.canCommit(), false)
    coordinator.endDispatch('new-request')
    assert.equal(replacement.canCommit(), true)
  } finally { store.close(); replacementStore.close() }
})
