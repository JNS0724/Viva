import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { createVivaMemoryClient } from '../src/backend/memory-client.ts'
import { registerRuntimeMemoryIpc } from '../src/backend/memory-ipc.ts'
import { createRemoteMemoryChannel } from '../src/backend/remote-memory-channel.ts'
import { MemoryComputeError } from '../src/memory/contracts/compute.ts'
import { createMemoryDreamJobs } from '../src/memory/core/memory-dream-jobs.ts'
import type { DreamCalculate } from '../src/memory/core/memory-dream-jobs.ts'
import { DREAM_PROFILE_SYSTEM } from '../src/memory/core/memory-dream-prompts.ts'
import { DREAM } from '../src/memory/core/memory-notes.ts'
import {
  CONFIRMED_SECTION_HEADING,
  MAX_PROFILE_L2_CHARS,
  measureConfirmedSectionL2,
  projectProfileL2,
  RESIDENT_PROFILE_PATH,
} from '../src/memory/core/resident-profile.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { createEffects } from '../src/memory/node/effects.ts'
import { createMemoryPhysicalFileReader, memoryFileRevision } from '../src/memory/node/memory-file-store.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { memoryHash, openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { createMemoryOwnerSupervisor } from '../src/memory/node/owner-supervisor.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { createMemoryActions } from '../src/renderer/memory-actions.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import { checkedIpc, type RawIpc } from '../src/shared/ipc-contract.ts'
import { scratch } from './fixtures/scratch.js'
import { noteSource } from './fixtures/memory-note-fixture.ts'

const TODAY_MS = Date.parse('2026-11-16T10:00:00.000Z')

function dreamHarness(t: TestContext, options: {
  initialNow?: number
  dreamUnits?: number
  readPhysicalOverride?: (
    defaultRead: (workspace: string, filePath: string, signal?: AbortSignal) => Promise<{ path: string, revision: string, markdown: string } | null>,
    workspace: string,
    filePath: string,
    signal?: AbortSignal,
  ) => Promise<{ path: string, revision: string, markdown: string } | null>
} = {}) {
  const { dir, defer } = scratch(t, 'phase2-dream-')
  const dbPath = path.join(dir, 'memory.db')
  let clock = options.initialNow ?? TODAY_MS
  let idSeq = 0

  let store!: ReturnType<typeof openMemoryStore>
  let effects!: ReturnType<typeof createEffects>
  let notes!: ReturnType<typeof openMemoryNotes>
  let documents!: ReturnType<typeof openMemoryDocuments>
  let jobs!: ReturnType<typeof createMemoryDreamJobs>

  const modelLog: Array<{ isProfilePass: boolean, system: string, input: Record<string, unknown>, hasTools: boolean }> = []
  let calculateImpl: DreamCalculate = async request => {
    const isProfilePass = request.system === DREAM_PROFILE_SYSTEM
    if (isProfilePass) return JSON.stringify({ action: 'NOOP' })
    return JSON.stringify({ operations: [] })
  }
  let onCommittedHook: ((receipt: { documentId: string, path: string, action: string }) => void) | undefined

  function openAll() {
    store = openMemoryStore(dbPath, () => clock)
    effects = createEffects({ db: store.db, now: () => clock, later: () => null, cancel: () => {} })
    const readable = (id: string) => Boolean(store.readSource(id)?.text)
    notes = openMemoryNotes(store, readable)
    documents = openMemoryDocuments({
      db: store.db,
      root: store.fileRoot,
      now: () => clock,
      source(id) {
        const current = store.readSource(id)
        return current?.text ? { text: current.text, workspace: memorySourceWorkspace(current), token: memorySourceToken(current) } : undefined
      },
    })
    const defaultReadPhysical = createMemoryPhysicalFileReader(() => store.fileRoot)
    jobs = createMemoryDreamJobs({
      store,
      notes,
      documents,
      effects,
      identity: {
        newId: () => `id-${++idSeq}`,
        hash: memoryHash,
      },
      now: () => clock,
      settings: { timezone: 'UTC', dreamUnits: options.dreamUnits ?? 6 },
      readable,
      eligible: () => true,
      source: id => store.readSource(id) ?? undefined,
      reference: id => ({ namespace: 'canonical', sourceId: id, revision: 1 }),
      transaction: write => store.tx(write),
      committed: receipt => onCommittedHook?.(receipt),
      readPhysicalFile: (workspace, filePath, signal) =>
        options.readPhysicalOverride
          ? options.readPhysicalOverride(defaultReadPhysical, workspace, filePath, signal)
          : defaultReadPhysical(workspace, filePath, signal),
      calculate: async request => {
        modelLog.push({
          isProfilePass: request.system === DREAM_PROFILE_SYSTEM,
          system: request.system,
          input: request.input as Record<string, unknown>,
          hasTools: Boolean(request.tools),
        })
        return calculateImpl(request)
      },
    })
  }

  openAll()
  defer(() => { try { effects.close() } catch { /* closed */ } try { store.close() } catch { /* already closed */ } })

  function addDailyNote(
    entries: Array<{ text: string, at?: number, project?: { kind: 'project', id: string } | null }>,
    opts: { session?: string, day?: string, title?: string } = {},
  ) {
    const session = opts.session ?? `sess-${randomUUID()}`
    const day = opts.day ?? '2026-11-16'
    const sources = entries.map((entry, idx) => {
      const project = entry.project ?? null
      const scope = project ?? { kind: 'user' as const }
      const at = entry.at ?? (clock + idx)
      return noteSource(store, {
        conversation: session,
        session,
        scope,
        context: scope,
        project,
        text: entry.text,
        hash: memoryHash(entry.text),
        length: entry.text.length,
        at,
        timezone: 'UTC',
      })
    })
    const key = notes.add(session, day, sources, '')!
    const rows = notes.pending(key)
    const refs = notes.snapshot(sources.map(s => s.id))
    const markdown = entries.map(e => `- ${e.text}`).join('\n')
    const ok = notes.commit(key, rows, { status: 'write', title: opts.title ?? 'Daily Note', markdown }, 1, clock, refs, undefined)
    assert.equal(ok, true)
    const note = notes.read(key)!
    return { key, note, sources, workspace: note.workspace, path: note.path }
  }

  return {
    dir,
    get store() { return store },
    get effects() { return effects },
    get notes() { return notes },
    get documents() { return documents },
    get jobs() { return jobs },
    modelLog,
    setNow(next: number) { clock = next },
    setModel(fn: DreamCalculate) { calculateImpl = fn },
    setCommittedHook(fn: ((receipt: { documentId: string, path: string, action: string }) => void) | undefined) { onCommittedHook = fn },
    addDailyNote,
    async run() {
      jobs.run()
      await effects.wake()
    },
    async restart() {
      effects.close()
      store.close()
      openAll()
    },
    async retryNow() {
      // Advance clock past retry backoff so scheduled retry becomes due and wake effects.
      const timing = effects.timing(DREAM, 'daily')
      if (timing && timing.dueAt > clock) clock = timing.dueAt + 1
      await effects.wake()
    },
    diskPath(workspace: string, filePath: string) {
      return path.join(store.fileRoot, workspace, filePath)
    },
  }
}

test('zero-onboarding Dream generates global resident profile isolated to USER_WORKSPACE and blocks non-user writes', async t => {
  const h = dreamHarness(t)
  const userDaily = h.addDailyNote([{ text: '我叫林晓，回答习惯先给结论，偏好中文。' }])
  const project = { kind: 'project' as const, id: 'proj-alpha' }
  const projDaily = h.addDailyNote([{ text: '项目 Alpha 仅在周五发布。', project }])

  h.setModel(async request => {
    if (request.system === DREAM_PROFILE_SYSTEM) {
      const input = request.input as { canonicalSources: Array<{ sourceId: string, text: string }> }
      assert.equal(request.tools, undefined, 'profile pass must not expose any tools')
      assert.equal(input.canonicalSources.some(s => s.text.includes('Alpha')), false, 'project source must never reach profile pass')
      return JSON.stringify({
        action: 'CREATE',
        body: '- 称呼：林晓\n- 回答风格：先给结论，使用中文',
        sourceIds: [userDaily.sources[0]!.id],
      })
    }
    const input = request.input as { notes: Array<{ path: string, sourceIds: string[] }> }
    if (input.notes[0]!.path === projDaily.path) {
      return JSON.stringify({
        operations: [{
          action: 'CREATE',
          path: 'digest/procedure/alpha-release.md',
          name: 'Alpha Release',
          description: 'Alpha release rule',
          body: '项目 Alpha 仅在周五发布。',
          dailyPaths: [projDaily.path],
          sourceIds: [projDaily.sources[0]!.id],
        }],
      })
    }
    return JSON.stringify({ operations: [] })
  })

  await h.run()

  // Global resident profile exists ONLY in USER_WORKSPACE
  const profile = h.documents.read(userDaily.workspace, RESIDENT_PROFILE_PATH)
  assert.ok(profile)
  assert.match(profile.markdown, /## 自动整理/)
  assert.match(profile.markdown, /林晓/)
  assert.match(profile.markdown, /## Sources/)
  assert.equal(h.documents.read(projDaily.workspace, RESIDENT_PROFILE_PATH), null)

  // Non-USER_WORKSPACE commit to reserved profile path is hard-rejected
  const projSrc = projDaily.sources[0]!
  assert.throws(() => h.documents.commit({
    operationId: randomUUID(),
    workspace: projDaily.workspace,
    path: RESIDENT_PROFILE_PATH,
    expectedRevision: null,
    action: 'CREATE',
    markdown: '---\nname: Bad\ndescription: Bad\n---\n\n## 自动整理\n- leak',
    sources: [{ id: projSrc.id, token: memorySourceToken(projSrc) }],
    reads: [],
  }), /memory-reserved-profile-path/)

  // L2 projection strips ## Sources and stays bounded
  const projected = projectProfileL2(profile.markdown)
  assert.match(projected, /林晓/)
  assert.equal(projected.includes('## Sources'), false)
  assert.ok([...projected].length <= MAX_PROFILE_L2_CHARS)
})

test('two-section user correction protects appended items across Dream REFINES, blocks reserved Dream headings, and undo releases protection', async t => {
  const { dir, defer } = scratch(t, 'phase2-sections-')
  const root = path.join(dir, 'owner')
  const owner = openMemoryOwner({ root, dailyNotes: true, compute: () => null, route: () => null })
  defer(() => owner.close())
  await owner.recover()
  const store = openMemoryStore(path.join(root, 'memory.db'))
  defer(() => store.close())
  const documents = openMemoryDocuments({
    db: store.db,
    root: store.fileRoot,
    source(id) {
      const current = store.readSource(id)
      return current?.text ? { text: current.text, workspace: memorySourceWorkspace(current), token: memorySourceToken(current) } : undefined
    },
  })

  const session = randomUUID()
  const src1 = randomUUID()
  await owner.receiveSource({ sessionId: session, messageId: src1, text: '我习惯先看结论', at: TODAY_MS, timezone: 'UTC', turn: 1, cwd: null })
  const srcRow = store.readSource(src1)!
  const userWs = memorySourceWorkspace(srcRow)
  const created = documents.commit({
    operationId: randomUUID(),
    workspace: userWs,
    path: RESIDENT_PROFILE_PATH,
    expectedRevision: null,
    action: 'CREATE',
    markdown: '---\nname: Personal Profile\ndescription: Resident\n---\n\n## 自动整理\n- 习惯先看结论\n\n## Sources\n- [[daily/2026-11-16/note-a.md]]',
    sources: [{ id: srcRow.id, token: memorySourceToken(srcRow) }],
    reads: [],
  })
  const identity = { kind: 'digest' as const, workspace: userWs, id: created.documentId }
  const client = createVivaMemoryClient((m, input) => owner.handleHost(m, input) as Promise<never>)

  // User appends preference A at the end of the file -> deterministically placed into ## 用户确认
  const before = (await client.readFile(identity))!
  const edited = await client.editFile({
    operationId: randomUUID(),
    identity,
    version: before.version,
    text: `${before.editor!.text}\n- 始终不要用感叹号`,
  })
  const afterEdit = (await client.readFile(identity))!
  assert.match(afterEdit.markdown, /## 用户确认\n- 始终不要用感叹号/)
  assert.match(afterEdit.markdown, /## 自动整理\n- 习惯先看结论/)
  assert.match(owner.profileSnapshot().text, /## 用户确认\n- 始终不要用感叹号/)

  // Undo immediately restores original document without ## 用户确认 -> protection released
  assert.ok(afterEdit.actions.undo)
  await client.undoFile({
    operationId: randomUUID(),
    identity,
    version: afterEdit.version,
    changeId: afterEdit.actions.undo!.changeId,
  })
  const afterUndo = (await client.readFile(identity))!
  assert.equal(afterUndo.markdown.includes('## 用户确认'), false)
  assert.equal(edited.action, 'EDIT')

  // Now verify Dream reserved-heading guard on CREATE & REFINE AND preservation of ## 用户确认 across Dream REFINE
  const h = dreamHarness(t)
  const d1 = h.addDailyNote([{ text: '我喜欢清晨喝黑咖啡' }])
  let badAttempts = 0
  h.setModel(async request => {
    if (request.system !== DREAM_PROFILE_SYSTEM) return JSON.stringify({ operations: [] })
    badAttempts++
    if (badAttempts === 1) {
      // Attempt 1: illegal CREATE carrying ## 用户确认 -> must be rejected!
      return JSON.stringify({ action: 'CREATE', body: '## 用户确认\n- 伪造确认项', sourceIds: [d1.sources[0]!.id] })
    }
    return JSON.stringify({ action: 'CREATE', body: '- 清晨喝黑咖啡', sourceIds: [d1.sources[0]!.id] })
  })
  await h.run()
  assert.equal(badAttempts, 2, 'CREATE with ## 用户确认 must be rejected and retried')
  const createdDoc = h.documents.read(d1.workspace, RESIDENT_PROFILE_PATH)!
  assert.equal(createdDoc.markdown.includes('伪造确认项'), false)
  assert.match(createdDoc.markdown, /## 自动整理\n- 清晨喝黑咖啡/)

  // Manually insert ## 用户确认 into profile.md, then run Dream REFINE with duplicate heading attempt + valid new fact B
  const manualSrc = noteSource(h.store, {
    conversation: 'm', session: null,
    scope: { kind: 'user' as const }, context: { kind: 'user' as const }, project: null,
    text: '用户确认：只喝热饮', hash: memoryHash('用户确认：只喝热饮'), length: 9, at: TODAY_MS + 50, timezone: 'UTC',
  })
  h.documents.commit({
    operationId: randomUUID(),
    workspace: d1.workspace,
    path: RESIDENT_PROFILE_PATH,
    expectedRevision: createdDoc.revision,
    action: 'REFINE',
    markdown: '---\nname: Personal Profile\ndescription: Resident\n---\n\n## 用户确认\n- 只喝热饮\n\n## 自动整理\n- 清晨喝黑咖啡',
    sources: [...createdDoc.sources, { id: manualSrc.id, token: memorySourceToken(manualSrc) }],
    reads: [{ id: createdDoc.id, revision: createdDoc.revision, usageVersion: createdDoc.usageVersion }],
  })
  const d2 = h.addDailyNote([{ text: '我每晚九点跑步' }])
  let refineAttempts = 0
  h.setModel(async request => {
    if (request.system !== DREAM_PROFILE_SYSTEM) return JSON.stringify({ operations: [] })
    refineAttempts++
    if (refineAttempts === 1) {
      return JSON.stringify({ action: 'REFINE', body: '## 自动整理\n- 跑步\n## 自动整理\n- 重复标题', sourceIds: [d2.sources[0]!.id] })
    }
    return JSON.stringify({ action: 'REFINE', body: '- 清晨喝黑咖啡\n- 每晚九点跑步', sourceIds: [d2.sources[0]!.id] })
  })
  await h.run()
  assert.equal(refineAttempts, 2, 'REFINE with duplicate reserved heading must be rejected')
  const refined = h.documents.read(d1.workspace, RESIDENT_PROFILE_PATH)!
  assert.match(refined.markdown, /## 用户确认\n- 只喝热饮/)
  assert.match(refined.markdown, /每晚九点跑步/)
})

test('deletion watermark isolates profile planner input and tools, survives subsequent REFINE, and delete->recreate->restart keeps single active doc', async t => {
  const h = dreamHarness(t, { initialNow: TODAY_MS })
  const d0 = h.addDailyNote([{ text: '旧偏好：UNIQUE_DELETED_MARKER_999', at: TODAY_MS }])
  h.setModel(async request => {
    if (request.system !== DREAM_PROFILE_SYSTEM) return JSON.stringify({ operations: [] })
    return JSON.stringify({ action: 'CREATE', body: '- UNIQUE_DELETED_MARKER_999', sourceIds: [d0.sources[0]!.id] })
  })
  await h.run()
  const originalDoc = h.documents.read(d0.workspace, RESIDENT_PROFILE_PATH)!
  const oldDocId = originalDoc.id

  // Delete resident profile and set profile_deleted_at watermark
  const deleteAt = TODAY_MS + 1_000
  h.setNow(deleteAt)
  h.documents.deleteFile(d0.workspace, oldDocId, originalDoc.usageVersion)
  h.store.setMeta('profile_deleted_at', String(deleteAt))
  await h.restart()

  // Same-day batch mixing pre-delete unique marker AND post-delete new preference
  const mixed = h.addDailyNote([
    { text: '删除前旧证据：OLD_FORGOTTEN_SENTINEL_777', at: deleteAt - 500 },
    { text: '删除后新偏好：使用深色模式', at: deleteAt + 500 },
  ])
  let profilePlannerSaw: Record<string, unknown> | null = null
  let profilePlannerHadTools = false
  h.setModel(async request => {
    if (request.system === DREAM_PROFILE_SYSTEM) {
      profilePlannerSaw = request.input as Record<string, unknown>
      profilePlannerHadTools = Boolean(request.tools)
      const input = request.input as { canonicalSources: Array<{ sourceId: string }> }
      return JSON.stringify({
        action: 'CREATE',
        body: '- 使用深色模式',
        sourceIds: input.canonicalSources.map(s => s.sourceId),
      })
    }
    // Ordinary digest CAN still use the pre-delete source in the same batch!
    return JSON.stringify({
      operations: [{
        action: 'CREATE',
        path: 'digest/wiki/mixed-note.md',
        name: 'Mixed Note',
        description: 'Ordinary digest from pre-delete source',
        body: '记录了 OLD_FORGOTTEN_SENTINEL_777',
        dailyPaths: [mixed.path],
        sourceIds: [mixed.sources[0]!.id],
      }],
    })
  })
  await h.run()

  assert.ok(profilePlannerSaw)
  assert.equal(profilePlannerHadTools, false, 'profile planner must receive zero cross-document tools')
  assert.equal(JSON.stringify(profilePlannerSaw).includes('OLD_FORGOTTEN_SENTINEL_777'), false, 'pre-delete marker must NOT enter profile planner input')
  assert.equal(Object.hasOwn(profilePlannerSaw, 'notes'), false)
  assert.equal(Object.hasOwn(profilePlannerSaw, 'existingDigests'), false)

  const recreated = h.documents.read(d0.workspace, RESIDENT_PROFILE_PATH)!
  assert.ok(recreated)
  assert.notEqual(recreated.id, oldDocId)
  assert.match(recreated.markdown, /深色模式/)
  assert.equal(recreated.markdown.includes('OLD_FORGOTTEN_SENTINEL_777'), false)
  // Ordinary digest DID use the pre-delete source
  assert.match(h.documents.read(d0.workspace, 'digest/wiki/mixed-note.md')!.markdown, /OLD_FORGOTTEN_SENTINEL_777/)

  // Subsequent REFINE with another mixed batch still excludes pre-delete evidence
  const mixed2 = h.addDailyNote([
    { text: '再次混入删除前证据：PRE_DELETE_ROUND2_888', at: deleteAt - 100 },
    { text: '删除后补充：偏好极简表格', at: deleteAt + 2_000 },
  ])
  let refineSaw = ''
  h.setModel(async request => {
    if (request.system === DREAM_PROFILE_SYSTEM) {
      refineSaw = JSON.stringify(request.input)
      const input = request.input as { canonicalSources: Array<{ sourceId: string }> }
      return JSON.stringify({
        action: 'REFINE',
        body: '- 使用深色模式\n- 偏好极简表格',
        sourceIds: input.canonicalSources.map(s => s.sourceId),
      })
    }
    return JSON.stringify({ operations: [] })
  })
  await h.run()
  assert.equal(refineSaw.includes('PRE_DELETE_ROUND2_888'), false)
  assert.match(h.documents.read(d0.workspace, RESIDENT_PROFILE_PATH)!.markdown, /极简表格/)

  // Restart after delete -> recreate -> refine: new documentId readable, single active entry, old documentId unreadable
  await h.restart()
  const activeProfileDocs = h.documents.fileRegistry(d0.workspace).filter(row => row.path === RESIDENT_PROFILE_PATH)
  assert.equal(activeProfileDocs.length, 1)
  assert.equal(activeProfileDocs[0]!.id, recreated.id)
  assert.ok(h.documents.acceptedSnapshot(d0.workspace, recreated.id))
  assert.equal(h.documents.acceptedSnapshot(d0.workspace, oldDocId), null)
})

test('confirmed section == 800 succeeds and == 801 rejects end-to-end across desktop worker RPC + IPC with identical operationId replay and keeps renderer draft', async t => {
  const { dir, defer } = scratch(t, 'phase2-rpc-limit-')
  const root = path.join(dir, 'owner')
  let currentEpoch = ''
  let latestProfileText = ''
  let latestProfileRev = -1
  let channel!: ReturnType<typeof createRemoteMemoryChannel>
  const supervisor = createMemoryOwnerSupervisor({
    root,
    dailyNotes: true,
    callbacks: { compute: async () => '' },
    onEvent: event => {
      if (event.type === 'memory_owner_state') {
        currentEpoch = event.epoch
        channel.receive(event)
      } else if (event.type === 'memory_owner_profile') {
        latestProfileText = event.text
        latestProfileRev = event.revision
      }
    },
  })
  channel = createRemoteMemoryChannel({
    callOwner: (method, input, options) => supervisor.callHost(method, input, options),
  })
  defer(async () => { channel.close(); await supervisor.close() })
  await supervisor.start()
  await channel.waitReady()

  // Seed resident profile with a user source via direct store + commit
  const store = openMemoryStore(path.join(root, 'memory.db'))
  defer(() => store.close())
  const srcRecord = noteSource(store, {
    conversation: 'c1', session: 's1',
    scope: { kind: 'user' as const }, context: { kind: 'user' as const }, project: null,
    text: '初始偏好：简洁回答', hash: memoryHash('初始偏好：简洁回答'), length: 9, at: TODAY_MS, timezone: 'UTC',
  })
  const srcId = srcRecord.id
  const userWs = memorySourceWorkspace(srcRecord)
  const documents = openMemoryDocuments({
    db: store.db,
    root: store.fileRoot,
    source(id) {
      const current = store.readSource(id)
      return current?.text ? { text: current.text, workspace: memorySourceWorkspace(current), token: memorySourceToken(current) } : undefined
    },
  })
  const created = documents.commit({
    operationId: randomUUID(),
    workspace: userWs,
    path: RESIDENT_PROFILE_PATH,
    expectedRevision: null,
    action: 'CREATE',
    markdown: '---\nname: Personal Profile\ndescription: Resident\n---\n\n## 自动整理\n- 简洁回答\n\n## Sources\n- [[daily/2026-11-16/note-a.md]]',
    sources: [{ id: srcId, token: memorySourceToken(srcRecord) }],
    reads: [],
  })
  const identity = { kind: 'digest' as const, workspace: userWs, id: created.documentId }

  const client = createVivaMemoryClient(channel.call, channel.readBatch)
  const listeners = new Map<string, Parameters<RawIpc['handle']>[1]>()
  const ipc = checkedIpc({ handle: (name, fn) => { listeners.set(name, fn) }, on: () => {} })
  registerRuntimeMemoryIpc(ipc, {
    client, habits: () => ({ text: '', samples: 0 }), cwd: () => dir, chooseDocs: async () => null,
  })
  const callIpc = (ch: string, ...args: unknown[]) => listeners.get(ch)!({}, ...args)

  // 1. Exact limit (800 code points): "## 用户确认\n" is 8 code points, so 792 chars = 800 total!
  const before = (await client.readFile(identity))!
  const headingLen = [...`${CONFIRMED_SECTION_HEADING}\n`].length
  const exactLine = '字'.repeat(MAX_PROFILE_L2_CHARS - headingLen)
  const exactText = `${CONFIRMED_SECTION_HEADING}\n${exactLine}\n\n## 自动整理\n- 简洁回答`
  assert.equal(measureConfirmedSectionL2(exactText), MAX_PROFILE_L2_CHARS)
  const applied = await callIpc('memory:edit-file', {
    operationId: randomUUID(), identity, version: before.version, text: exactText,
  }) as { status: string }
  assert.equal(applied.status, 'applied')
  const afterExact = (await client.readFile(identity))!
  assert.match(afterExact.markdown, /## Sources/)
  assert.ok([...projectProfileL2(afterExact.markdown)].length <= MAX_PROFILE_L2_CHARS)
  assert.match(projectProfileL2(afterExact.markdown), new RegExp(exactLine))

  // Wait briefly for worker profile event after exact save
  await new Promise(resolve => setTimeout(resolve, 40))
  const revAfterExact = latestProfileRev
  const textAfterExact = latestProfileText
  assert.ok(currentEpoch)

  // 2. Exceeding by 1 code point (801): submit TWICE with the SAME operationId over full worker RPC + IPC!
  const overLine = '超'.repeat(MAX_PROFILE_L2_CHARS - headingLen + 1)
  const overText = `${CONFIRMED_SECTION_HEADING}\n${overLine}\n\n## 自动整理\n- 简洁回答`
  assert.equal(measureConfirmedSectionL2(overText), MAX_PROFILE_L2_CHARS + 1)
  const sameOpId = randomUUID()
  const firstReject = await callIpc('memory:edit-file', {
    operationId: sameOpId, identity, version: afterExact.version, text: overText,
  })
  const secondReject = await callIpc('memory:edit-file', {
    operationId: sameOpId, identity, version: afterExact.version, text: overText,
  })
  const expectedReject = {
    status: 'rejected',
    code: 'profile.confirmed_too_long',
    details: { limit: MAX_PROFILE_L2_CHARS, actual: MAX_PROFILE_L2_CHARS + 1 },
  }
  assert.deepEqual(firstReject, expectedReject)
  assert.deepEqual(secondReject, expectedReject, 'replayed failed operationId must return identical details')
  // Disk & L2 unchanged
  assert.equal((await client.readFile(identity))!.markdown, afterExact.markdown)
  assert.equal(latestProfileRev, revAfterExact)
  assert.equal(latestProfileText, textAfterExact)

  // 3. Renderer saveMemoryFileEditor keeps user draft editable and formats actionable message with actual & limit
  let uiState: State = reduce(initialState, { type: 'memory_open' })
  const uiActions = createMemoryActions({
    api: {
      editMemoryFile: async (req: unknown) => callIpc('memory:edit-file', req) as Promise<never>,
    } as unknown as AgentApi,
    getState: () => uiState,
    dispatch: action => { uiState = reduce(uiState, action) },
    errorMessage: String,
    showToast: () => {},
  })
  uiState = reduce(uiState, {
    type: 'memory_file_editor',
    editor: {
      id: 7, kind: 'edit', identity, version: afterExact.version, originalTitle: 'Personal Profile',
      draft: { title: 'Personal Profile', text: overText },
    },
  })
  assert.equal(await uiActions.saveMemoryFileEditor(7, { title: 'Personal Profile', text: overText }), false)
  assert.equal(uiState.memory.files.editor?.draft.text, overText, 'rejected draft stays editable')
  assert.match(uiState.memory.files.editor?.error ?? '', /801/)
  assert.match(uiState.memory.files.editor?.error ?? '', /800/)
})

test('Dream recovery covers mid-commit crash, post-receipts crash, move-aside vs in-place edit, EACCES non-blocking + read-only dreamStatus, mixed plan, Profile.md case variant, effectiveHasMore, and oversized cross-restart', async t => {
  // === Scenario A: Mid-commit crash (ordinary digest committed, profile not yet) + post-receipts pre-checkpoint crash ===
  {
    const h = dreamHarness(t)
    const d1 = h.addDailyNote([{ text: '每周五提交周报，偏好深蓝主题。' }])
    let abortOnDigest = true
    h.setCommittedHook(receipt => {
      if (abortOnDigest && receipt.path === 'digest/procedure/weekly.md') {
        abortOnDigest = false
        throw new Error('simulated-crash-after-digest')
      }
    })
    h.setModel(async request => {
      if (request.system === DREAM_PROFILE_SYSTEM) {
        return JSON.stringify({ action: 'CREATE', body: '- 偏好深蓝主题', sourceIds: [d1.sources[0]!.id] })
      }
      return JSON.stringify({
        operations: [{
          action: 'CREATE', path: 'digest/procedure/weekly.md', name: 'Weekly', description: 'Weekly report',
          body: '每周五提交周报。', dailyPaths: [d1.path], sourceIds: [d1.sources[0]!.id],
        }],
      })
    })
    await h.run()
    // Digest committed once, profile not yet committed, pendingBatch persisted!
    const digestAfterCrash = h.documents.read(d1.workspace, 'digest/procedure/weekly.md')!
    assert.ok(digestAfterCrash)
    assert.equal(digestAfterCrash.usageVersion, 1)
    assert.equal(h.documents.read(d1.workspace, RESIDENT_PROFILE_PATH), null)
    const callsBeforeRestart = h.modelLog.length

    // Restart and resume: skips digest via receipt (usageVersion stays 1), commits profile once, checkpoints, 0 new model calls!
    h.setCommittedHook(undefined)
    await h.restart()
    await h.retryNow()
    assert.equal(h.modelLog.length, callsBeforeRestart, 'recovery must not re-run planners')
    assert.equal(h.documents.read(d1.workspace, 'digest/procedure/weekly.md')!.usageVersion, 1)
    assert.match(h.documents.read(d1.workspace, RESIDENT_PROFILE_PATH)!.markdown, /深蓝主题/)
    assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
  }

  // === Scenario B: Partial commit + move-aside vs in-place edit ===
  {
    let hideNote = false
    const h = dreamHarness(t, {
      async readPhysicalOverride(defaultRead, workspace, filePath, signal) {
        if (hideNote && filePath.startsWith('daily/')) return null
        return defaultRead(workspace, filePath, signal)
      },
    })
    const d1 = h.addDailyNote([{ text: '偏好安静办公环境。' }])
    let crashOnce = true
    h.setCommittedHook(receipt => {
      if (crashOnce && receipt.path === 'digest/personal/office.md') {
        crashOnce = false
        throw new Error('crash-between-ops')
      }
    })
    h.setModel(async request => {
      if (request.system === DREAM_PROFILE_SYSTEM) {
        return JSON.stringify({ action: 'CREATE', body: '- 偏好安静办公环境', sourceIds: [d1.sources[0]!.id] })
      }
      return JSON.stringify({
        operations: [{
          action: 'CREATE', path: 'digest/personal/office.md', name: 'Office', description: 'Office pref',
          body: '偏好安静办公环境。', dailyPaths: [d1.path], sourceIds: [d1.sources[0]!.id],
        }],
      })
    })
    await h.run()
    assert.ok(h.documents.read(d1.workspace, 'digest/personal/office.md'))
    assert.equal(h.documents.read(d1.workspace, RESIDENT_PROFILE_PATH), null)
    const callsBefore = h.modelLog.length

    // (d1) Move note aside -> retry preserves pendingBatch (0 new model calls, profile still uncommitted)
    h.setCommittedHook(undefined)
    hideNote = true
    await h.restart()
    await h.retryNow()
    assert.equal(h.modelLog.length, callsBefore)
    assert.equal(h.documents.read(d1.workspace, RESIDENT_PROFILE_PATH), null)

    // Move note back -> resumes pendingBatch, commits profile once with original operationId, 0 planner re-runs!
    hideNote = false
    await h.restart()
    await h.retryNow()
    assert.equal(h.modelLog.length, callsBefore)
    assert.equal(h.documents.read(d1.workspace, 'digest/personal/office.md')!.usageVersion, 1)
    assert.ok(h.documents.read(d1.workspace, RESIDENT_PROFILE_PATH))
    assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
  }

  // === Scenario B2: Partial commit + in-place edit on disk retires old pendingBatch and processes healthy note ===
  {
    const h = dreamHarness(t)
    const d1 = h.addDailyNote([{ text: '原版内容：咖啡加奶' }])
    let crashOnce = true
    h.setCommittedHook(receipt => {
      if (crashOnce && receipt.path === 'digest/personal/drink.md') {
        crashOnce = false
        throw new Error('crash-before-profile')
      }
    })
    h.setModel(async request => {
      if (request.system === DREAM_PROFILE_SYSTEM) {
        return JSON.stringify({ action: 'CREATE', body: '- 咖啡加奶', sourceIds: [d1.sources[0]!.id] })
      }
      return JSON.stringify({
        operations: [{
          action: 'CREATE', path: 'digest/personal/drink.md', name: 'Drink', description: 'Drink',
          body: '原版内容：咖啡加奶', dailyPaths: [d1.path], sourceIds: [d1.sources[0]!.id],
        }],
      })
    })
    await h.run()
    assert.equal(h.documents.read(d1.workspace, RESIDENT_PROFILE_PATH), null)

    // Edit d1 in-place on disk (different hash!) + add healthy note d2
    h.setCommittedHook(undefined)
    fs.writeFileSync(h.diskPath(d1.workspace, d1.path), '# externally tampered on disk\n', 'utf8')
    const d2 = h.addDailyNote([{ text: '健康日记：使用键盘快捷键' }])
    h.setModel(async request => {
      if (request.system === DREAM_PROFILE_SYSTEM) {
        return JSON.stringify({ action: 'CREATE', body: '- 使用键盘快捷键', sourceIds: [d2.sources[0]!.id] })
      }
      return JSON.stringify({ operations: [] })
    })
    await h.restart()
    await h.retryNow()
    // Old pendingBatch retired (no '咖啡加奶' profile), healthy d2 processed!
    const profile = h.documents.read(d2.workspace, RESIDENT_PROFILE_PATH)!
    assert.match(profile.markdown, /使用键盘快捷键/)
    assert.equal(profile.markdown.includes('咖啡加奶'), false)
  }

  // === Scenario C: EACCES on note A (post-receipt) + healthy note B + manual Dream (init & join IDs) + read-only status(id) + delete control ===
  {
    let failAPhysical = false
    let noteAPath = ''
    const h = dreamHarness(t, {
      async readPhysicalOverride(defaultRead, workspace, filePath, signal) {
        if (failAPhysical && filePath === noteAPath) {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        }
        return defaultRead(workspace, filePath, signal)
      },
    })
    const noteA = h.addDailyNote([{ text: '日记A偏好：早起健身' }])
    noteAPath = noteA.path
    // Trigger EACCES right after profile commits, before checkpoint runs!
    h.setCommittedHook(receipt => {
      if (receipt.path === RESIDENT_PROFILE_PATH) failAPhysical = true
    })
    h.setModel(async request => {
      if (request.system === DREAM_PROFILE_SYSTEM) {
        return JSON.stringify({ action: 'CREATE', body: '- 早起健身', sourceIds: [noteA.sources[0]!.id] })
      }
      return JSON.stringify({ operations: [] })
    })
    await h.run()
    // Profile committed, A moved to deferredCheckpoints (EACCES during checkpoint)!
    assert.ok(h.documents.read(noteA.workspace, RESIDENT_PROFILE_PATH))
    const profileRevAfterA = h.documents.read(noteA.workspace, RESIDENT_PROFILE_PATH)!.usageVersion

    // Add healthy note B while A is STILL EACCES, and trigger manual Dream with initiating ID + joining ID!
    h.setCommittedHook(undefined)
    const noteB = h.addDailyNote([{ text: '日记B：偏好用清单整理任务' }])
    h.setModel(async request => {
      if (request.system === DREAM_PROFILE_SYSTEM) {
        return JSON.stringify({ action: 'NOOP' })
      }
      return JSON.stringify({
        operations: [{
          action: 'CREATE', path: 'digest/procedure/todo.md', name: 'Todo', description: 'Todo list',
          body: '偏好用清单整理任务', dailyPaths: [noteB.path], sourceIds: [noteB.sources[0]!.id],
        }],
      })
    })
    const initId = randomUUID()
    const joinId = randomUUID()
    const reqInit = h.jobs.request(initId)
    const reqJoin = h.jobs.request(joinId)
    assert.equal(reqJoin.jobId, reqInit.jobId, 'second request joins the active manual job')
    await h.effects.wake()

    // B committed & checkpointed, manual receipt settled for BOTH initId and joinId (read-only status)!
    assert.ok(h.documents.read(noteB.workspace, 'digest/procedure/todo.md'))
    const sInit = h.jobs.status(initId)
    const sJoin = h.jobs.status(joinId)
    assert.equal(sInit.jobId, reqInit.jobId)
    assert.equal(sJoin.jobId, reqInit.jobId)
    assert.equal(typeof sInit.completedAt, 'number')
    assert.equal(sJoin.completedAt, sInit.completedAt)
    assert.equal(sInit.lastCheckResult, 'processed')

    // Background retry tick while A is STILL EACCES must NOT overwrite lastCheckResult with 'empty'!
    await h.restart()
    assert.equal(h.jobs.status(initId).completedAt, sInit.completedAt, 'read-only status survives restart')
    assert.equal(h.jobs.status(joinId).completedAt, sInit.completedAt, 'joined ID read-only status survives restart')
    const callsBeforeNoopTick = h.modelLog.length
    await h.retryNow()
    assert.equal(h.modelLog.length, callsBeforeNoopTick)
    assert.equal(h.jobs.status().lastCheckResult, 'processed', 'no-op deferred background tick must not overwrite lastCheckResult')

    // Restore A readability -> A checkpoints with 0 model calls and 0 profile revision bumps!
    failAPhysical = false
    await h.retryNow()
    assert.equal(h.modelLog.length, callsBeforeNoopTick)
    assert.equal(h.documents.read(noteA.workspace, RESIDENT_PROFILE_PATH)!.usageVersion, profileRevAfterA)
    assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
  }

  // === Scenario D: Mixed plan + case-variant Profile.md + post-filter effectiveHasMore ===
  {
    const h = dreamHarness(t)
    const d1 = h.addDailyNote([{ text: '我喜欢安静工作，项目文档放 Wiki。' }])
    let consolidateCalls = 0
    h.setModel(async request => {
      if (request.system === DREAM_PROFILE_SYSTEM) {
        return JSON.stringify({ action: 'CREATE', body: '- 喜欢安静工作', sourceIds: [d1.sources[0]!.id] })
      }
      consolidateCalls++
      // Return case-variant digest/personal/Profile.md + valid ordinary digest!
      return JSON.stringify({
        operations: [
          {
            action: 'CREATE', path: 'digest/personal/Profile.md', name: 'Bad Profile', description: 'Case variant',
            body: '占坑内容', dailyPaths: [d1.path], sourceIds: [d1.sources[0]!.id],
          },
          {
            action: 'CREATE', path: 'digest/wiki/docs.md', name: 'Docs', description: 'Docs location',
            body: '项目文档放 Wiki。', dailyPaths: [d1.path], sourceIds: [d1.sources[0]!.id],
          },
        ],
        hasMore: false,
      })
    })
    await h.run()
    assert.equal(consolidateCalls, 1, 'mixed plan should strip Profile.md without retrying consolidate')
    assert.equal(h.documents.read(d1.workspace, 'digest/personal/Profile.md'), null)
    assert.equal(h.documents.read(d1.workspace, 'digest/wiki/docs.md')!.usageVersion, 1)
    assert.equal(h.documents.read(d1.workspace, RESIDENT_PROFILE_PATH)!.usageVersion, 1)

    // Post-filter hasMore: ONLY a reserved profile op with hasMore: true -> effectiveHasMore becomes false!
    const d2 = h.addDailyNote([{ text: '周末喜欢爬山' }])
    let hasMoreCalls = 0
    h.setModel(async request => {
      if (request.system === DREAM_PROFILE_SYSTEM) {
        return JSON.stringify({ action: 'REFINE', body: '- 喜欢安静工作\n- 周末喜欢爬山', sourceIds: [d2.sources[0]!.id] })
      }
      hasMoreCalls++
      return JSON.stringify({
        operations: [{
          action: 'CREATE', path: 'digest/personal/profile.md', name: 'Reserved', description: 'Reserved',
          body: '不应提交', dailyPaths: [d2.path], sourceIds: [d2.sources[0]!.id],
        }],
        hasMore: true,
      })
    })
    await h.run()
    assert.equal(hasMoreCalls, 1, 'filtering to empty must reset effectiveHasMore to false instead of looping')
    assert.match(h.documents.read(d2.workspace, RESIDENT_PROFILE_PATH)!.markdown, /周末喜欢爬山/)
    assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
  }

  // === Scenario E: Single-note context-window-exceeded flows into profile pass and preserves size-limit across restart ===
  {
    let failCheckpoint = false
    const h = dreamHarness(t, {
      async readPhysicalOverride(defaultRead, workspace, filePath, signal) {
        if (failCheckpoint && filePath.startsWith('daily/')) return null
        return defaultRead(workspace, filePath, signal)
      },
    })
    const d1 = h.addDailyNote([{ text: '单篇超窗中的短偏好：偏好简洁代码' }])
    h.setCommittedHook(receipt => {
      if (receipt.path === RESIDENT_PROFILE_PATH) failCheckpoint = true
    })
    h.setModel(async request => {
      if (request.system === DREAM_PROFILE_SYSTEM) {
        return JSON.stringify({ action: 'CREATE', body: '- 偏好简洁代码', sourceIds: [d1.sources[0]!.id] })
      }
      throw new MemoryComputeError('context-window-exceeded')
    })
    await h.run()
    assert.equal(h.documents.read(d1.workspace, RESIDENT_PROFILE_PATH)!.usageVersion, 1)

    // Restart and let checkpoint finish: profile stays usageVersion=1, lastCheckResult === 'size-limit'!
    h.setCommittedHook(undefined)
    failCheckpoint = false
    await h.restart()
    await h.retryNow()
    assert.equal(h.documents.read(d1.workspace, RESIDENT_PROFILE_PATH)!.usageVersion, 1)
    assert.equal(h.jobs.status().lastCheckResult, 'size-limit')
    assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
  }
})

test('renderer memory-actions separates pendingDreamRequest from watchingDreamOperation so retry-state clicks start fresh while polling tracks completion', async t => {
  let state: State = reduce(initialState, { type: 'memory_open' })
  const dispatch = (action: Action) => { state = reduce(state, action) }
  const runIds: string[] = []
  const polledIds: Array<string | undefined> = []
  const retryStatus = { state: 'retry' as const, lastCheckResult: 'processed' as const, lastCheckedAt: 100, lastProcessedAt: 100 }
  let statusCalls = 0
  const api = {
    async runDream(opId: string) {
      runIds.push(opId)
      return { ...retryStatus, state: 'queued' as const, jobId: opId, completedAt: null }
    },
    async getDreamStatus(opId?: string) {
      polledIds.push(opId)
      statusCalls++
      if (statusCalls === 1) return retryStatus
      if (statusCalls === 2) return { ...retryStatus, jobId: opId, completedAt: 200 }
      return retryStatus
    },
  }
  const actions = createMemoryActions({
    api: api as AgentApi, getState: () => state, dispatch, errorMessage: String, showToast: () => {},
  })
  t.after(() => actions.watchDream(false))
  actions.watchDream(true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.memory.dream?.state, 'retry')

  // Clicking Run Dream while state === 'retry' starts a fresh operation ID
  await actions.runDream()
  assert.equal(runIds.length, 1)
  // Simulate state returning to 'retry' before next click (e.g. deferred checkpoint still retrying)
  dispatch({ type: 'memory_dream_status', status: { ...retryStatus, jobId: runIds[0], completedAt: 200 } })
  // Second manual click while in 'retry' must generate a NEW operation ID!
  await actions.runDream()
  assert.equal(runIds.length, 2)
  assert.notEqual(runIds[1], runIds[0])
})
