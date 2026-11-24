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
  assembleDreamProfileBody,
  CONFIRMED_SECTION_HEADING,
  MAX_PROFILE_L2_CHARS,
  measureConfirmedSectionL2,
  parseProfileSections,
  projectProfileL2,
  RESIDENT_PROFILE_PATH,
} from '../src/memory/core/resident-profile.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { createEffects } from '../src/memory/node/effects.ts'
import { createMemoryPhysicalFileReader, memoryFileRevision, readMemoryFileAtCommit } from '../src/memory/node/memory-file-store.ts'
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
  eligible?: (source: { id: string }) => boolean
  readPhysicalOverride?: (
    defaultRead: (workspace: string, filePath: string, signal?: AbortSignal) => Promise<{ path: string, revision: string, markdown: string } | null>,
    workspace: string,
    filePath: string,
    signal?: AbortSignal,
  ) => Promise<{ path: string, revision: string, markdown: string } | null>
  readFileAtCommitOverride?: (
    defaultRead: (workspace: string, filePath: string) => { path: string, revision: string, markdown: string } | null,
    workspace: string,
    filePath: string,
  ) => { path: string, revision: string, markdown: string } | null
  omitReadFileAtCommit?: boolean
  omitReadFileRevisionAtCommit?: boolean
  omitReadPhysicalFile?: boolean
  readFileRevisionAtCommitOverride?: (
    defaultRead: (workspace: string, filePath: string) => string | undefined,
    workspace: string,
    filePath: string,
  ) => string | undefined
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
    const defaultReadAtCommit = (workspace: string, filePath: string) => readMemoryFileAtCommit(store.fileRoot, workspace, filePath)
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
      eligible: src => options.eligible ? options.eligible(src) : true,
      source: id => store.readSource(id) ?? undefined,
      reference: id => ({ namespace: 'canonical', sourceId: id, revision: 1 }),
      transaction: write => store.tx(write),
      committed: receipt => onCommittedHook?.(receipt),
      ...(options.omitReadPhysicalFile
        ? {}
        : {
            readPhysicalFile: (workspace: string, filePath: string, signal?: AbortSignal) =>
              options.readPhysicalOverride
                ? options.readPhysicalOverride(defaultReadPhysical, workspace, filePath, signal)
                : defaultReadPhysical(workspace, filePath, signal),
          }),
      ...(options.omitReadFileAtCommit
        ? options.omitReadFileRevisionAtCommit
          ? {}
          : {
              readFileRevisionAtCommit: (workspace: string, filePath: string) =>
                options.readFileRevisionAtCommitOverride
                  ? options.readFileRevisionAtCommitOverride((w, p) => defaultReadAtCommit(w, p)?.revision, workspace, filePath)
                  : defaultReadAtCommit(workspace, filePath)?.revision,
            }
        : {
            readFileAtCommit: (workspace: string, filePath: string) =>
              options.readFileAtCommitOverride
                ? options.readFileAtCommitOverride(defaultReadAtCommit, workspace, filePath)
                : defaultReadAtCommit(workspace, filePath),
            ...(options.omitReadFileRevisionAtCommit ? {} : { readFileRevisionAtCommit: (workspace: string, filePath: string) => defaultReadAtCommit(workspace, filePath)?.revision }),
          }),
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

test('real Dream-generated resident profile with 64-hex daily note provenance link edits cleanly while still rejecting new secrets (P1-1)', async t => {
  const { dir, defer } = scratch(t, 'phase2-p1-1-')
  const root = path.join(dir, 'memory')
  const owner = openMemoryOwner({ root, dailyNotes: true, compute: () => null, route: () => null })
  defer(() => owner.close())
  await owner.recover()
  const store = openMemoryStore(path.join(root, 'memory.db'))
  defer(() => store.close())
  const notes = openMemoryNotes(store, () => true)
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
  const noteKey = notes.add(session, '2026-11-16', [srcRow], '好的', src1)!
  const rows = notes.pending(noteKey, 10)
  const notePath = `daily/2026-11-16/note-${memoryFileRevision(noteKey)}.md`
  assert.match(notePath, /^daily\/2026-11-16\/note-[a-f0-9]{64}\.md$/u)
  assert.equal(notes.commit(noteKey, rows, { status: 'write', title: 'Daily', markdown: '用户习惯先看结论' }, 1, TODAY_MS, notes.snapshot([src1]), undefined), true)
  const created = documents.commit({
    operationId: randomUUID(),
    workspace: userWs,
    path: RESIDENT_PROFILE_PATH,
    expectedRevision: null,
    action: 'CREATE',
    markdown: `---\nname: Personal Profile\ndescription: Resident\n---\n\n## 自动整理\n- 习惯先看结论\n\n## Sources\n- [[${notePath}]]`,
    sources: [{ id: srcRow.id, token: memorySourceToken(srcRow) }],
    reads: [],
  })
  const identity = { kind: 'digest' as const, workspace: userWs, id: created.documentId }
  const client = createVivaMemoryClient((m, input) => owner.handleHost(m, input) as Promise<never>)

  const before = (await client.readFile(identity))!
  assert.ok(before.editor!.text.includes(notePath))

  // Editing by appending an ordinary preference MUST succeed (not falsely flagged by looksSecret on 64-hex note path).
  const edited = await client.editFile({
    operationId: randomUUID(),
    identity,
    version: before.version,
    text: `${before.editor!.text}\n- 回答简洁直接`,
  })
  assert.equal(edited.action, 'EDIT')

  // Edited profile remains readable and projected to L2.
  const after = (await client.readFile(identity))!
  assert.ok(after)
  assert.match(after.markdown, /## 用户确认\n- 回答简洁直接/)
  assert.ok(after.markdown.includes(notePath))
  assert.match(owner.profileSnapshot().text, /## 用户确认\n- 回答简洁直接/)

  // Appending a real secret or an untrusted 64-hex token MUST still be rejected with credentials!
  await assert.rejects(() => client.editFile({
    operationId: randomUUID(),
    identity,
    version: after.version,
    text: `${after.editor!.text}\n- api_key: sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234`,
  }), (err: unknown) => Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'credentials'))

  await assert.rejects(() => client.editFile({
    operationId: randomUUID(),
    identity,
    version: after.version,
    text: `${after.editor!.text}\n- [[daily/2026-11-16/note-${'a1'.repeat(32)}.md]]`,
  }), (err: unknown) => Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'credentials'))
})

test('pre-deletion question answered after profile deletion hides pre-deletion question text from profile planner (P1-2)', async t => {
  const deleteAt = TODAY_MS + 1_000
  const h = dreamHarness(t, { initialNow: deleteAt })
  h.store.setMeta('profile_deleted_at', String(deleteAt))

  // Question card was asked BEFORE deleteAt (questionAt = deleteAt - 500), answered AFTER deleteAt (at = deleteAt + 500)
  // in a fresh turn with NO prior questionContext.
  const ansId = randomUUID()
  const ansSrc = {
    id: ansId, operation: ansId, version: 1,
    conversation: 'conv-q', session: 'sess-q',
    scope: { kind: 'user' as const }, context: { kind: 'user' as const }, project: null,
    author: 'answer' as const,
    text: '是的，以后都用英文',
    hash: memoryHash('是的，以后都用英文'),
    length: 9,
    question: '是否沿用已删除旧画像里的 SECRET_OLD_PROFILE_HINT？',
    questionAt: deleteAt - 500,
    requestId: 'req-q1',
    questionId: 'q1',
    at: deleteAt + 500,
    timezone: 'UTC',
    outcome: 'note-pending',
  }
  h.store.insertSource(ansSrc)
  const noteKey = h.notes.add('sess-q', '2026-11-16', [ansSrc], '收到', ansId, [], '收到', { questionSources: [], questionCurrent: true })!
  const rows = h.notes.pending(noteKey, 10)
  assert.equal(h.notes.commit(noteKey, rows, { status: 'write', title: 'Q Note', markdown: '回答：是的，以后都用英文' }, 1, deleteAt + 600, h.notes.snapshot([ansId]), undefined), true)

  type ProfileInputSnapshot = { canonicalSources: Array<{ sourceId: string, text: string, question: string | null, questionUnavailable: boolean }> }
  let profileInputSeen: ProfileInputSnapshot | undefined
  h.setModel(async request => {
    if (request.system !== DREAM_PROFILE_SYSTEM) return JSON.stringify({ operations: [] })
    profileInputSeen = request.input as ProfileInputSnapshot
    return JSON.stringify({ action: 'CREATE', body: '- 以后都用英文', sourceIds: [ansId] })
  })
  await h.run()

  assert.ok(profileInputSeen)
  const seen = profileInputSeen as ProfileInputSnapshot
  assert.equal(seen.canonicalSources.length, 1)
  assert.equal(seen.canonicalSources[0]!.question, null, 'pre-deletion question text must be stripped')
  assert.equal(seen.canonicalSources[0]!.questionUnavailable, true)
  assert.equal(seen.canonicalSources[0]!.text, '是的，以后都用英文')
  assert.equal(JSON.stringify(seen).includes('SECRET_OLD_PROFILE_HINT'), false)
})

test('multi-note profile pass context-window-exceeded splits batch instead of skipping all notes (P1-4)', async t => {
  const h = dreamHarness(t, { initialNow: TODAY_MS })
  const d1 = h.addDailyNote([{ text: '偏好一：喜欢喝绿茶' }], { session: 's-split-1' })
  const d2 = h.addDailyNote([{ text: '偏好二：周末去爬山' }], { session: 's-split-2' })

  let profileCalls = 0
  let sawSplitMulti = false
  h.setModel(async request => {
    if (request.system !== DREAM_PROFILE_SYSTEM) return JSON.stringify({ operations: [] })
    profileCalls++
    const input = request.input as { actionMode: 'CREATE' | 'REFINE', canonicalSources: Array<{ sourceId: string, text: string }> }
    if (input.canonicalSources.length > 1) {
      sawSplitMulti = true
      throw new MemoryComputeError('context-window-exceeded')
    }
    const only = input.canonicalSources[0]!
    return JSON.stringify({
      action: input.actionMode,
      body: input.actionMode === 'CREATE' ? `- ${only.text}` : `- 偏好一：喜欢喝绿茶\n- ${only.text}`,
      sourceIds: [only.sourceId],
    })
  })
  await h.run()

  assert.equal(sawSplitMulti, true)
  assert.equal(profileCalls, 3, '2-note oversized profile pass must split into 2 single-note passes')
  const profile = h.documents.read(d1.workspace, RESIDENT_PROFILE_PATH)!
  assert.ok(profile)
  assert.match(profile.markdown, /绿茶/)
  assert.match(profile.markdown, /爬山/)
  assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
  void d2
})

test('partial-commit recovery clears pendingBatch when one file is missing and another is modified in place regardless of order (P1-5)', async t => {
  for (const order of [['missing-first', 'modified-second'], ['modified-first', 'missing-second']] as const) {
    let hidePath: string | null = null
    const h = dreamHarness(t, {
      initialNow: TODAY_MS,
      async readPhysicalOverride(defaultRead, workspace, filePath, signal) {
        if (hidePath && filePath === hidePath) return null
        return defaultRead(workspace, filePath, signal)
      },
    })
    const d1 = h.addDailyNote([{ text: '素材一：第一篇日记偏好' }], { session: `s-p1-5-${order[0]}-1` })
    const d2 = h.addDailyNote([{ text: '素材二：第二篇日记偏好' }], { session: `s-p1-5-${order[0]}-2` })
    const missingNote = order[0] === 'missing-first' ? d1 : d2
    const modifiedNote = order[0] === 'missing-first' ? d2 : d1

    let stopAfterOrdinary = false
    h.setCommittedHook(receipt => {
      if (receipt.path === 'digest/wiki/partial-first.md' && !stopAfterOrdinary) {
        stopAfterOrdinary = true
        throw new Error('simulated-crash-mid-commit')
      }
    })
    h.setModel(async request => {
      if (request.system === DREAM_PROFILE_SYSTEM) {
        const input = request.input as { canonicalSources: Array<{ sourceId: string }> }
        return JSON.stringify({ action: 'CREATE', body: '- 偏好合并', sourceIds: input.canonicalSources.map(s => s.sourceId) })
      }
      return JSON.stringify({
        operations: [{
          action: 'CREATE',
          path: 'digest/wiki/partial-first.md',
          name: 'Partial First',
          description: 'First op before crash',
          body: '普通摘要内容',
          dailyPaths: [d1.path],
          sourceIds: [d1.sources[0]!.id],
        }],
      })
    })
    await h.run()
    assert.ok(h.documents.read(d1.workspace, 'digest/wiki/partial-first.md'))
    assert.equal(h.documents.read(d1.workspace, RESIDENT_PROFILE_PATH), null)
    assert.ok(h.effects.get(DREAM, 'daily')?.payload, 'pendingBatch must exist after mid-commit crash')

    // Hide missingNote (temporary missing -> null) AND mutate modifiedNote in place on disk (confirmed stale)!
    h.setCommittedHook(undefined)
    hidePath = missingNote.path
    const absModified = path.join(h.store.fileRoot, modifiedNote.workspace, modifiedNote.path)
    fs.writeFileSync(absModified, `${fs.readFileSync(absModified, 'utf8')}\n<!-- tampered in place -->`)

    await h.restart()
    h.setModel(async request => {
      if (request.system === DREAM_PROFILE_SYSTEM) return JSON.stringify({ action: 'NOOP' })
      return JSON.stringify({ operations: [] })
    })
    await h.retryNow()

    // Old pendingBatch MUST have been cleared as stale (not stuck retrying forever on missingNote),
    // and old profile op MUST NOT have been committed!
    assert.equal(h.documents.read(d1.workspace, RESIDENT_PROFILE_PATH), null)
    const remainingPayload = h.effects.get(DREAM, 'daily')?.payload as { pendingBatch?: unknown } | null
    assert.equal(remainingPayload?.pendingBatch, undefined, `pendingBatch must be cleared in order ${order.join(',')}`)
  }
})

test('reserved profile heading guard matches CommonMark ATX closing hashes, indentation, inline formatting, and Setext H2 headings consistently (P1-6, R2 P1-3)', () => {
  for (const forged of [
    '## 用户确认 ##\n- 伪造项',
    '  ##   用户确认   ###  \n- 伪造项',
    '##\tUser Confirmed\t##\n- forged',
    '用户确认\n---\n- 伪造项',
    '  User Confirmed  \n------\n- forged',
    '### 用户确认\n- 伪造项',
    '## **用户确认**\n- 粗体伪造项',
    '## _User Confirmed_ ##\n- italic forged',
    '## <span>用户确认</span>\n- html forged',
    '> ## **用户确认**\n> - 引用块伪造项',
  ]) {
    assert.throws(
      () => assembleDreamProfileBody({ existingBody: null, autoSummaryBody: forged, action: 'CREATE' }),
      /dream-profile-reserved-heading/,
      `CREATE must reject forged heading: ${JSON.stringify(forged)}`,
    )
    assert.throws(
      () => assembleDreamProfileBody({ existingBody: '## 自动整理\n- 旧偏好', autoSummaryBody: forged, action: 'REFINE' }),
      /dream-profile-reserved-heading/,
      `REFINE must reject forged heading: ${JSON.stringify(forged)}`,
    )
    assert.equal(parseProfileSections(forged).hasConfirmedHeading, true)
  }
  // Heading inside fenced code block is NOT a section heading.
  const fenced = '## 自动整理\n```md\n## **用户确认**\n```\n- 正常偏好'
  const parsedFenced = parseProfileSections(fenced)
  assert.equal(parsedFenced.hasConfirmedHeading, false)
  assert.equal(parsedFenced.duplicateReservedHeading, false)
})

test('deleted document old ID cannot modify or undo recreated document at the same path (P1-7)', async t => {
  const { dir, defer } = scratch(t, 'phase2-p1-7-')
  const store = openMemoryStore(path.join(dir, 'memory.db'))
  defer(() => store.close())
  const documents = openMemoryDocuments({
    db: store.db,
    root: store.fileRoot,
    source(id) {
      const current = store.readSource(id)
      return current?.text ? { text: current.text, workspace: memorySourceWorkspace(current), token: memorySourceToken(current) } : undefined
    },
  })
  const src1 = noteSource(store, {
    conversation: 'c1', session: null, scope: { kind: 'user' }, context: { kind: 'user' }, project: null,
    text: '偏好一', hash: memoryHash('偏好一'), length: 3, at: TODAY_MS, timezone: 'UTC',
  })
  const ws = memorySourceWorkspace(src1)
  const md = '---\nname: Personal Profile\ndescription: Resident\n---\n\n## 自动整理\n- 偏好一'
  const first = documents.commit({
    operationId: randomUUID(), workspace: ws, path: RESIDENT_PROFILE_PATH,
    expectedRevision: null, action: 'CREATE', markdown: md,
    sources: [{ id: src1.id, token: memorySourceToken(src1) }], reads: [],
  })
  documents.deleteFile(ws, first.documentId, first.usageVersion)
  const second = documents.commit({
    operationId: randomUUID(), workspace: ws, path: RESIDENT_PROFILE_PATH,
    expectedRevision: null, action: 'CREATE', markdown: md,
    sources: [{ id: src1.id, token: memorySourceToken(src1) }], reads: [],
  })
  assert.notEqual(second.documentId, first.documentId)
  assert.equal(second.revision, first.revision)
  assert.equal(second.usageVersion, first.usageVersion)

  assert.ok(second.revision)
  assert.throws(() => documents.setEnabled({
    operationId: randomUUID(), workspace: ws, documentId: first.documentId,
    expectedRevision: second.revision!, expectedUsageVersion: second.usageVersion, enabled: false,
  }), /memory-document-unavailable/)

  assert.throws(() => documents.undo({
    operationId: randomUUID(), workspace: ws, documentId: first.documentId,
    revision: second.revision!, usageVersion: second.usageVersion,
  }), /memory-document-unavailable/)

  const live = documents.read(ws, RESIDENT_PROFILE_PATH)!
  assert.equal(live.id, second.documentId)
  assert.equal(live.enabled, true)
  assert.equal(live.usageVersion, second.usageVersion)
})

test('Dream pre-validation strips uppercase .MD / Digest/ reserved profile variants without failing ordinary ops (P2-5)', async t => {
  const h = dreamHarness(t, { initialNow: TODAY_MS })
  const d1 = h.addDailyNote([{ text: '今天定了项目里程碑和浅色主题偏好' }])
  let generalCalls = 0
  h.setModel(async request => {
    if (request.system === DREAM_PROFILE_SYSTEM) {
      return JSON.stringify({ action: 'CREATE', body: '- 浅色主题偏好', sourceIds: [d1.sources[0]!.id] })
    }
    generalCalls++
    if (generalCalls === 1) {
      return JSON.stringify({
        operations: [
          {
            action: 'CREATE',
            path: 'digest/personal/profile.MD',
            name: 'Profile Upper Ext',
            description: 'Should be stripped before digestPath regex',
            body: '误写画像',
            dailyPaths: [d1.path],
            sourceIds: [d1.sources[0]!.id],
          },
          {
            action: 'CREATE',
            path: 'Digest/personal/profile.md',
            name: 'Profile Upper Prefix',
            description: 'Should also be stripped',
            body: '误写画像二',
            dailyPaths: [d1.path],
            sourceIds: [d1.sources[0]!.id],
          },
          {
            action: 'CREATE',
            path: 'digest/wiki/dep-on-upper-profile.md',
            name: 'Dependent On Uppercase Profile',
            description: 'Must be stripped because it links to profile.MD',
            body: '引用了 [[digest/personal/profile.MD]] 的依赖草案',
            dailyPaths: [d1.path],
            sourceIds: [d1.sources[0]!.id],
          },
          {
            action: 'CREATE',
            path: 'digest/wiki/milestone-p2-5.md',
            name: 'Milestone',
            description: 'Valid ordinary digest',
            body: '项目里程碑已确定',
            dailyPaths: [d1.path],
            sourceIds: [d1.sources[0]!.id],
          },
        ],
        hasMore: true,
      })
    }
    return JSON.stringify({ operations: [], hasMore: false })
  })
  await h.run()
  assert.equal(generalCalls, 1)
  assert.equal(h.documents.read(d1.workspace, 'digest/wiki/dep-on-upper-profile.md'), null, 'dependent op linking to uppercase profile.MD must be stripped')
  assert.ok(h.documents.read(d1.workspace, 'digest/wiki/milestone-p2-5.md'))
  assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 1, 'hasMore=true must keep note checkpoint open for next pass')

  await h.retryNow()
  assert.equal(generalCalls, 2, 'second pass finishes after hasMore=true')
  assert.ok(h.documents.read(d1.workspace, RESIDENT_PROFILE_PATH))
  assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
})

test('profile_deleted_at watermark stays monotonic across system clock rollback (P2-6)', async t => {
  const { dir, defer } = scratch(t, 'phase2-p2-6-')
  const root = path.join(dir, 'memory')
  let clock = TODAY_MS + 10_000
  const owner = openMemoryOwner({ root, dailyNotes: true, now: () => clock, compute: () => null, route: () => null })
  defer(() => owner.close())
  await owner.recover()
  const store = openMemoryStore(path.join(root, 'memory.db'), () => clock)
  defer(() => store.close())
  const documents = openMemoryDocuments({
    db: store.db,
    root: store.fileRoot,
    now: () => clock,
    source(id) {
      const current = store.readSource(id)
      return current?.text ? { text: current.text, workspace: memorySourceWorkspace(current), token: memorySourceToken(current) } : undefined
    },
  })
  const client = createVivaMemoryClient((m, input) => owner.handleHost(m, input) as Promise<never>)

  const session = randomUUID()
  const src1 = randomUUID()
  await owner.receiveSource({ sessionId: session, messageId: src1, text: '初版偏好', at: TODAY_MS + 1_000, timezone: 'UTC', turn: 1, cwd: null })
  const srcRow1 = store.readSource(src1)!
  const ws = memorySourceWorkspace(srcRow1)
  const first = documents.commit({
    operationId: randomUUID(), workspace: ws, path: RESIDENT_PROFILE_PATH,
    expectedRevision: null, action: 'CREATE',
    markdown: '---\nname: Personal Profile\ndescription: Resident\n---\n\n## 自动整理\n- 初版偏好',
    sources: [{ id: srcRow1.id, token: memorySourceToken(srcRow1) }], reads: [],
  })
  const firstDetail = (await client.readFile({ kind: 'digest', workspace: ws, id: first.documentId }))!
  // Delete #1 at t = TODAY_MS + 10_000
  await client.forgetFile({ operationId: randomUUID(), identity: firstDetail.identity, version: firstDetail.version })
  const watermark1 = Number(store.meta('profile_deleted_at'))
  assert.equal(watermark1, TODAY_MS + 10_000)

  // Recreate with post-delete source at t = TODAY_MS + 12_000
  const src2 = randomUUID()
  await owner.receiveSource({ sessionId: session, messageId: src2, text: '重建偏好', at: TODAY_MS + 12_000, timezone: 'UTC', turn: 2, cwd: null })
  const srcRow2 = store.readSource(src2)!
  const second = documents.commit({
    operationId: randomUUID(), workspace: ws, path: RESIDENT_PROFILE_PATH,
    expectedRevision: null, action: 'CREATE',
    markdown: '---\nname: Personal Profile\ndescription: Resident\n---\n\n## 自动整理\n- 重建偏好',
    sources: [{ id: srcRow2.id, token: memorySourceToken(srcRow2) }], reads: [],
  })
  const secondDetail = (await client.readFile({ kind: 'digest', workspace: ws, id: second.documentId }))!
  // Roll clock BACKWARDS to TODAY_MS + 5_000 and delete again!
  clock = TODAY_MS + 5_000
  await client.forgetFile({ operationId: randomUUID(), identity: secondDetail.identity, version: secondDetail.version })
  const watermark2 = Number(store.meta('profile_deleted_at'))
  assert.equal(watermark2, watermark1, 'profile_deleted_at must never move backwards on clock rollback')

  // Now run REAL Dream on a pending daily note referencing src2 (+12_000): profile_deleted_source_seq must block resurrection!
  const notes = openMemoryNotes(store, () => true)
  const noteKey = notes.add(session, '2026-11-16', [srcRow2], '好的', src2)!
  const rows = notes.pending(noteKey, 10)
  assert.equal(notes.commit(noteKey, rows, { status: 'write', title: 'Rollback Note', markdown: '重建偏好' }, 1, TODAY_MS + 12_000, notes.snapshot([src2]), undefined), true)
  const effects = createEffects({ db: store.db, now: () => clock })
  defer(() => effects.close())
  let profilePlannerSaw: unknown = null
  const jobs = createMemoryDreamJobs({
    store, notes, documents, effects, now: () => clock, transaction: store.tx,
    identity: { newId: randomUUID, hash: memoryHash },
    readable: () => true, eligible: () => true,
    source: id => store.readSource(id) ?? undefined,
    reference: id => { const s = store.readSource(id); return s ? { namespace: 'canonical', sourceId: s.id, revision: s.version } : null },
    allowsText: () => true, committed: () => {},
    async calculate(request) {
      if (request.system === DREAM_PROFILE_SYSTEM) {
        profilePlannerSaw = request.input
        return JSON.stringify({ action: 'CREATE', body: '- 不应复活', sourceIds: [src2] })
      }
      return JSON.stringify({ operations: [] })
    },
  })
  jobs.run()
  await effects.wake()
  assert.equal(profilePlannerSaw, null, 'profile planner must NOT receive pre-second-deletion source even after clock rollback')
  assert.equal(documents.read(ws, RESIDENT_PROFILE_PATH), null, 'profile must NOT be resurrected from source predating second delete')
})

test('ordinary Dream plan reading X without linking it is invalidated if X mutates in place during profile pass (R2 P1-2)', async t => {
  const h = dreamHarness(t, { initialNow: TODAY_MS })
  const d0 = h.addDailyNote([{ text: '项目背景：旧版配置 X' }], { session: 's-r2-p1-2-0' })
  // Seed existing digest X
  const xReceipt = h.documents.commit({
    operationId: randomUUID(),
    workspace: d0.workspace,
    path: 'digest/wiki/doc-x.md',
    expectedRevision: null,
    action: 'CREATE',
    markdown: '---\nname: Doc X\ndescription: Background\n---\n\n旧版配置 X 正文',
    sources: [{ id: d0.sources[0]!.id, token: memorySourceToken(d0.sources[0]!) }],
    reads: [],
  })
  h.notes.markProcessed(d0.key, d0.note.revision)

  const d1 = h.addDailyNote([{ text: '根据配置生成新的决策 Y，我偏好深色主题' }], { session: 's-r2-p1-2-1' })
  h.setModel(async request => {
    if (request.system === DREAM_PROFILE_SYSTEM) {
      // Mutate X in place on disk while profile pass is running!
      const absX = path.join(h.store.fileRoot, d0.workspace, 'digest/wiki/doc-x.md')
      fs.writeFileSync(absX, `${fs.readFileSync(absX, 'utf8')}\n<!-- mutated during profile pass -->`)
      return JSON.stringify({ action: 'NOOP' })
    }
    // Ordinary consolidate searches, reads X, and proposes Y WITHOUT linking [[doc-x.md]]
    const searchRes = await request.tools!.executeTool({ callId: 'c1', name: 'node_search', input: { query: 'Doc X' } })
    assert.equal(searchRes.state, 'completed')
    const readRes = await request.tools!.executeTool({ callId: 'c2', name: 'read', input: { path: 'digest/wiki/doc-x.md' } })
    assert.equal(readRes.state, 'completed')
    assert.match(readRes.content, /旧版配置 X 正文/)
    return JSON.stringify({
      operations: [{
        action: 'CREATE',
        path: 'digest/wiki/doc-y.md',
        name: 'Doc Y',
        description: 'Derived from X without link',
        body: '基于旧版配置 X 的结论 Y',
        dailyPaths: [d1.path],
        sourceIds: [d1.sources[0]!.id],
      }],
    })
  })
  await h.run()

  assert.equal(h.documents.read(d0.workspace, 'digest/wiki/doc-y.md'), null, 'Y must NOT commit when read dependency X mutated during profile pass')
  assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 1, 'daily note checkpoint must NOT advance when Y was invalidated')
})

test('ordinary Dream plan reading an already-processed daily note is invalidated if that daily note mutates during profile pass (R3 P1-2)', async t => {
  const h = dreamHarness(t, { initialNow: TODAY_MS })
  const d0 = h.addDailyNote([{ text: '历史背景日记：服务器位于上海机房' }], { session: 's-r3-p1-2-0', day: '2026-11-15' })
  h.notes.markProcessed(d0.key, d0.note.revision)

  const d1 = h.addDailyNote([{ text: '结合历史背景生成运维总结，我偏好精简输出' }], { session: 's-r3-p1-2-1', day: '2026-11-16' })
  h.setModel(async request => {
    if (request.system === DREAM_PROFILE_SYSTEM) {
      // Mutate already-processed daily note d0 in place on disk while profile pass is running!
      const absD0 = path.join(h.store.fileRoot, d0.workspace, d0.path)
      fs.writeFileSync(absD0, `${fs.readFileSync(absD0, 'utf8')}\n<!-- daily mutated during profile pass -->`)
      return JSON.stringify({ action: 'NOOP' })
    }
    const readRes = await request.tools!.executeTool({ callId: 'c-daily', name: 'read', input: { path: d0.path } })
    assert.equal(readRes.state, 'completed')
    assert.match(readRes.content, /上海机房/)
    return JSON.stringify({
      operations: [{
        action: 'CREATE',
        path: 'digest/wiki/ops-summary.md',
        name: 'Ops Summary',
        description: 'Derived from d0 daily note without link',
        body: '运维部署位于上海机房',
        dailyPaths: [d1.path],
        sourceIds: [d1.sources[0]!.id],
      }],
    })
  })
  await h.run()

  assert.equal(h.documents.read(d0.workspace, 'digest/wiki/ops-summary.md'), null, 'digest must NOT commit when read daily note d0 mutated during profile pass')
  assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 1, 'd1 checkpoint must NOT advance when d0 mutated')
})

test('pre-deletion question with clock rollback is blocked by profile_deletion_generation even when answered after delete with no context deps (R3 P1-1)', async t => {
  let clock = TODAY_MS + 10_000
  const { dir, defer } = scratch(t, 'memory-r3-p1-1-question-gen-')
  const store = openMemoryStore(path.join(dir, 'memory.db'), () => clock)
  defer(() => store.close())
  const owner = openMemoryOwner({ root: dir, dailyNotes: true, now: () => clock, compute: () => null, route: () => null })
  defer(() => owner.close())
  await owner.recover()
  const session = 'sess-r3-qgen'

  // Seed & delete profile #1 after rolling clock BACKWARDS relative to question's askedAt!
  const src1 = randomUUID()
  await owner.receiveSource({ sessionId: session, messageId: src1, text: '初始画像来源', at: TODAY_MS, timezone: 'UTC', turn: 1, cwd: null })
  const srcRow1 = store.readSource(src1)!
  const ws = memorySourceWorkspace(srcRow1)
  const documents = openMemoryDocuments({
    db: store.db,
    root: store.fileRoot,
    now: () => clock,
    source(id) {
      const current = store.readSource(id)
      return current?.text ? { text: current.text, workspace: memorySourceWorkspace(current), token: memorySourceToken(current) } : undefined
    },
  })
  const first = documents.commit({
    operationId: randomUUID(), workspace: ws, path: RESIDENT_PROFILE_PATH,
    expectedRevision: null, action: 'CREATE',
    markdown: '---\nname: Personal Profile\ndescription: Resident\n---\n\n## 自动整理\n- 初始画像来源',
    sources: [{ id: srcRow1.id, token: memorySourceToken(srcRow1) }], reads: [],
  })
  // Question was issued BEFORE deletion at gen=0 with askedAt = TODAY_MS + 10_000
  const preDeleteGen = owner.runtime.profileDeletionGeneration()
  assert.equal(preDeleteGen, 0)
  const preDeleteAskedAt = clock // TODAY_MS + 10_000

  // Clock rolls BACKWARDS to TODAY_MS + 5_000 right before profile deletion!
  clock = TODAY_MS + 5_000
  const client = createVivaMemoryClient((m, input) => owner.handleHost(m, input) as Promise<never>)
  const firstDetail = (await client.readFile({ kind: 'digest', workspace: ws, id: first.documentId }))!
  await client.forgetFile({ operationId: randomUUID(), identity: firstDetail.identity, version: firstDetail.version })
  assert.equal(owner.runtime.profileDeletionGeneration(), 1)
  assert.equal(Number(store.meta('profile_deleted_at')), TODAY_MS + 5_000)

  // User answers four questions AFTER deletion (all get seq > deletedSeq and at > watermark, with questionCurrent: true & empty deps!):
  // 1) old generation (gen=0 < 1, questionAt > watermark due to rollback) -> MUST BE BLOCKED
  // 2) missing generation (gen=undefined, questionAt > watermark due to rollback) -> MUST BE BLOCKED (fail closed)
  // 3) current generation (gen=1 >= 1) with questionAt = watermark - 1 -> MUST BE BLOCKED (R5 P1-1)
  // 4) current generation (gen=1 >= 1) with questionAt > watermark -> MUST BE ALLOWED
  clock = TODAY_MS + 6_000
  const oldGenId = randomUUID()
  const missingGenId = randomUUID()
  const preWatermarkCurrentGenId = randomUUID()
  const currentGenId = randomUUID()
  owner.runtime.accept(
    '旧代回答：我喜欢要点回复',
    { conversation: session, session, scope: { kind: 'user' }, context: { kind: 'user' } },
    oldGenId,
    { question: '机密旧问题（gen=0）', requestId: 'req-q1', questionId: 'q1', custom: true, questionAt: preDeleteAskedAt, questionProfileGen: preDeleteGen },
    { deferAutomatic: true, at: clock, timezone: 'UTC' },
  )
  owner.runtime.accept(
    '缺失代回答：我也喜欢中文回复',
    { conversation: session, session, scope: { kind: 'user' }, context: { kind: 'user' } },
    missingGenId,
    { question: '机密旧问题（gen缺失）', requestId: 'req-q2', questionId: 'q2', custom: true, questionAt: preDeleteAskedAt },
    { deferAutomatic: true, at: clock + 1, timezone: 'UTC' },
  )
  owner.runtime.accept(
    '当前代但时间早于水位回答：请优先给代码',
    { conversation: session, session, scope: { kind: 'user' }, context: { kind: 'user' } },
    preWatermarkCurrentGenId,
    { question: '早于删除水位1ms的问题（gen=1）', requestId: 'req-q2b', questionId: 'q2b', custom: true, questionAt: TODAY_MS + 5_000 - 1, questionProfileGen: 1 },
    { deferAutomatic: true, at: clock + 2, timezone: 'UTC' },
  )
  owner.runtime.accept(
    '当前代回答：请用简洁专业口吻',
    { conversation: session, session, scope: { kind: 'user' }, context: { kind: 'user' } },
    currentGenId,
    { question: '删除后的新问题（gen=1）', requestId: 'req-q3', questionId: 'q3', custom: true, questionAt: clock + 3, questionProfileGen: 1 },
    { deferAutomatic: true, at: clock + 3, timezone: 'UTC' },
  )
  const oldGenRow = store.readSource(oldGenId)!
  const missingGenRow = store.readSource(missingGenId)!
  const preWatermarkCurrentGenRow = store.readSource(preWatermarkCurrentGenId)!
  const currentGenRow = store.readSource(currentGenId)!
  assert.equal(oldGenRow.questionProfileGen, 0)
  assert.equal(missingGenRow.questionProfileGen, null)
  assert.equal(preWatermarkCurrentGenRow.questionProfileGen, 1)
  assert.equal(currentGenRow.questionProfileGen, 1)

  const notes = openMemoryNotes(store, () => true)
  const noteKey = notes.add(
    session, '2026-11-16', [oldGenRow, missingGenRow, preWatermarkCurrentGenRow, currentGenRow], '好的', oldGenId, [], '好的',
    { questionSources: [], questionCurrent: true },
  )!
  const rows = notes.pending(noteKey, 10)
  assert.equal(notes.commit(noteKey, rows, { status: 'write', title: 'Answer Note', markdown: '回答汇总' }, 1, clock + 3, notes.snapshot([oldGenId, missingGenId, preWatermarkCurrentGenId, currentGenId]), undefined), true)
  const effects = createEffects({ db: store.db, now: () => clock + 3 })
  defer(() => effects.close())

  const seen = new Map<string, { question: string | null, questionUnavailable: boolean }>()
  const jobs = createMemoryDreamJobs({
    store, notes, documents, effects, now: () => clock + 3, transaction: store.tx,
    identity: { newId: randomUUID, hash: memoryHash },
    readable: () => true, eligible: () => true,
    source: id => store.readSource(id) ?? undefined,
    reference: id => { const s = store.readSource(id); return s ? { namespace: 'canonical', sourceId: s.id, revision: s.version } : null },
    allowsText: () => true, committed: () => {},
    async calculate(request) {
      if (request.system === DREAM_PROFILE_SYSTEM) {
        const payload = request.input as { canonicalSources: Array<{ sourceId: string, question: string | null, questionUnavailable: boolean }> }
        for (const entry of payload.canonicalSources) {
          seen.set(entry.sourceId, { question: entry.question, questionUnavailable: entry.questionUnavailable })
        }
        return JSON.stringify({ action: 'NOOP' })
      }
      return JSON.stringify({ operations: [] })
    },
  })
  jobs.run()
  await effects.wake()
  assert.deepEqual(seen.get(oldGenId), { question: null, questionUnavailable: true }, 'old generation (0 < 1) must be blocked even with questionCurrent:true and clock rollback')
  assert.deepEqual(seen.get(missingGenId), { question: null, questionUnavailable: true }, 'missing generation must fail closed after deletion even when questionAt > watermark')
  assert.deepEqual(seen.get(preWatermarkCurrentGenId), { question: null, questionUnavailable: true }, 'current generation with questionAt <= profile_deleted_at must be blocked (R5 P1-1)')
  assert.deepEqual(seen.get(currentGenId), { question: '删除后的新问题（gen=1）', questionUnavailable: false }, 'current generation (1 >= 1) with questionAt > watermark must reach profile planner')
})

test('repeated Dream REFINE preserves multi-paragraph confirmed section, link defs, and wikilink subheadings verbatim near 800-char limit (R3 P1-3, R4 P1-3)', () => {
  const confirmedParagraphs = `${'A'.repeat(780)}\n\nEND`
  const initial = `## 用户确认\n${confirmedParagraphs}\n\n## 自动整理\n- 旧整理`
  let current = initial
  for (let i = 0; i < 6; i++) {
    current = assembleDreamProfileBody({ existingBody: current, autoSummaryBody: `- 第 ${i + 1} 轮整理`, action: 'REFINE' })
    const parsed = parseProfileSections(current)
    assert.equal(parsed.confirmedLines.join('\n'), confirmedParagraphs, `confirmed section must stay verbatim after REFINE #${i + 1}`)
    const projected = projectProfileL2(current)
    assert.ok(projected.includes('END'), `L2 projection must not drift or truncate END on REFINE #${i + 1}`)
  }

  const withRefLink = '## 用户确认\n[Example][my-link]\n\n[my-link]: https://example.org\n\n## 自动整理\n- old'
  const refined = assembleDreamProfileBody({ existingBody: withRefLink, autoSummaryBody: '- new', action: 'REFINE' })
  assert.equal(parseProfileSections(refined).confirmedLines.join('\n'), '[Example][my-link]\n\n[my-link]: https://example.org')

  // R4 P1-3: subheading with wikilink inside ## 用户确认 must NOT be misclassified as reserved ## 自动整理!
  const withWikilinkSubheading = '## 用户确认\n### 自动整理 [[digest/wiki/guide.md]]\n保留的确认段落，绝不能在 REFINE 中丢失。\n\n## 自动整理\n- 旧整理'
  const refinedSub = assembleDreamProfileBody({ existingBody: withWikilinkSubheading, autoSummaryBody: '- 新整理', action: 'REFINE' })
  assert.equal(
    parseProfileSections(refinedSub).confirmedLines.join('\n'),
    '### 自动整理 [[digest/wiki/guide.md]]\n保留的确认段落，绝不能在 REFINE 中丢失。',
    'wikilink subheading and paragraph under ## 用户确认 must survive REFINE intact',
  )
  assert.ok(refinedSub.includes('保留的确认段落，绝不能在 REFINE 中丢失。'))
})

test('mixed Dream plan does not discard independent digest with inline-code profile example inside a Markdown table, and strips YAML-shaped body referencing stripped profile draft (R3 P2-1, R4 P2-1)', async t => {
  const h = dreamHarness(t, { initialNow: TODAY_MS })
  const d1 = h.addDailyNote([{ text: '表格示例说明与个人习惯' }], { session: 's-r3-p2-1' })
  h.setModel(async request => {
    if (request.system === DREAM_PROFILE_SYSTEM) return JSON.stringify({ action: 'NOOP' })
    await request.tools!.executeTool({ callId: 'c1', name: 'node_search', input: { query: '表格' } })
    return JSON.stringify({
      operations: [
        {
          action: 'CREATE',
          path: 'digest/personal/profile.MD',
          name: 'Bad Uppercase Profile',
          description: 'Reserved variant to be stripped',
          body: '- bad profile draft',
          dailyPaths: [d1.path],
          sourceIds: [d1.sources[0]!.id],
        },
        {
          action: 'CREATE',
          path: 'digest/wiki/yaml-dependent.md',
          name: 'Yaml Dependent',
          description: 'Dependent digest with leading --- block referencing stripped profile draft',
          body: '---\nrelated: "[[digest/personal/profile.MD]]"\n---\n依赖被剔除画像草案的正文',
          dailyPaths: [d1.path],
          sourceIds: [d1.sources[0]!.id],
        },
        {
          action: 'CREATE',
          path: 'digest/wiki/table-guide.md',
          name: 'Table Guide',
          description: 'Independent digest mentioning profile path inside inline code in a table',
          body: '| Example |\n| --- |\n| `[[digest/personal/profile.MD]]` |',
          dailyPaths: [d1.path],
          sourceIds: [d1.sources[0]!.id],
        },
      ],
    })
  })
  await h.run()

  assert.equal(h.documents.read(d1.workspace, RESIDENT_PROFILE_PATH), null)
  assert.equal(h.documents.read(d1.workspace, 'digest/wiki/yaml-dependent.md'), null, 'dependent digest with leading --- YAML-shaped block linking stripped profile draft must be stripped')
  const guide = h.documents.read(d1.workspace, 'digest/wiki/table-guide.md')
  assert.ok(guide, 'independent digest with inline-code wikilink inside Markdown table must NOT be stripped')

  // R5 P2-1: REFINE with edits[] replacing BASE inside [[BASE]] -> [[digest/personal/profile.MD]] must also be stripped!
  const hRefine = dreamHarness(t, { initialNow: TODAY_MS })
  const d0R = hRefine.addDailyNote([{ text: '初始词条' }], { session: 's-r5-p2-1-0', day: '2026-11-15' })
  hRefine.documents.commit({
    operationId: randomUUID(),
    workspace: d0R.workspace,
    path: 'digest/wiki/base-link.md',
    expectedRevision: null,
    action: 'CREATE',
    markdown: '---\nname: Base Link\ndescription: Has placeholder link\n---\n\n参考 [[BASE]] 词条。',
    sources: [{ id: d0R.sources[0]!.id, token: memorySourceToken(d0R.sources[0]!) }],
    reads: [],
  })
  hRefine.notes.markProcessed(d0R.key, d0R.note.revision)
  const d1R = hRefine.addDailyNote([{ text: '更新占位符链接到保留路径' }], { session: 's-r5-p2-1-1', day: '2026-11-16' })
  hRefine.setModel(async request => {
    if (request.system === DREAM_PROFILE_SYSTEM) return JSON.stringify({ action: 'NOOP' })
    await request.tools!.executeTool({ callId: 'c1', name: 'node_search', input: { query: 'Base Link' } })
    const readRes = await request.tools!.executeTool({ callId: 'c2', name: 'read', input: { path: 'digest/wiki/base-link.md' } })
    assert.equal(readRes.state, 'completed')
    return JSON.stringify({
      operations: [
        {
          action: 'CREATE',
          path: 'digest/personal/profile.MD',
          name: 'Bad Profile',
          description: 'Reserved draft to strip',
          body: '- bad profile draft',
          dailyPaths: [d1R.path],
          sourceIds: [d1R.sources[0]!.id],
        },
        {
          action: 'REFINE',
          path: 'digest/wiki/base-link.md',
          name: 'Base Link',
          description: 'Introduces link to stripped profile draft via fragment edit',
          edits: [{ oldText: 'BASE', newText: 'digest/personal/profile.MD' }],
          dailyPaths: [d1R.path],
          sourceIds: [d1R.sources[0]!.id],
        },
      ],
    })
  })
  await hRefine.run()
  const baseAfter = hRefine.documents.read(d0R.workspace, 'digest/wiki/base-link.md')!
  assert.ok(!baseAfter.markdown.includes('digest/personal/profile.MD'), 'REFINE replacing BASE inside [[BASE]] with stripped profile draft must be stripped (R5 P2-1)')
  assert.ok(baseAfter.markdown.includes('[[BASE]]'))

  // R6 P2-2: (a) Unrelated prose REFINE on a doc ALREADY containing [[digest/personal/profile.md]] must NOT be discarded;
  //          (b) CREATE with 4 leading spaces before [[digest/personal/profile.MD]] must be trimmed and stripped!
  const hR6 = dreamHarness(t, { initialNow: TODAY_MS })
  const d0R6 = hR6.addDailyNote([{ text: '已有个人画像链接的说明文档' }], { session: 's-r6-p2-2-0', day: '2026-11-15' })
  hR6.documents.commit({
    operationId: randomUUID(),
    workspace: d0R6.workspace,
    path: 'digest/wiki/existing-ref.md',
    expectedRevision: null,
    action: 'CREATE',
    markdown: '---\nname: Existing Ref\ndescription: Already links profile\n---\n\n已引用 [[digest/personal/profile.md]]，原正文。',
    sources: [{ id: d0R6.sources[0]!.id, token: memorySourceToken(d0R6.sources[0]!) }],
    reads: [],
  })
  hR6.notes.markProcessed(d0R6.key, d0R6.note.revision)
  const d1R6 = hR6.addDailyNote([{ text: '补充一段独立文字并测试缩进链接' }], { session: 's-r6-p2-2-1', day: '2026-11-16' })
  hR6.setModel(async request => {
    if (request.system === DREAM_PROFILE_SYSTEM) return JSON.stringify({ action: 'NOOP' })
    await request.tools!.executeTool({ callId: 'c1', name: 'node_search', input: { query: 'Existing Ref' } })
    const readRes = await request.tools!.executeTool({ callId: 'c2', name: 'read', input: { path: 'digest/wiki/existing-ref.md' } })
    assert.equal(readRes.state, 'completed')
    return JSON.stringify({
      operations: [
        {
          action: 'CREATE',
          path: 'digest/personal/profile.MD',
          name: 'Bad Profile',
          description: 'Reserved draft to strip',
          body: '- bad profile draft',
          dailyPaths: [d1R6.path],
          sourceIds: [d1R6.sources[0]!.id],
        },
        {
          action: 'CREATE',
          path: 'digest/wiki/indented-dep.md',
          name: 'Indented Dep',
          description: '4 leading spaces before link trimmed by schema',
          body: '    [[digest/personal/profile.MD]]\n后续说明',
          dailyPaths: [d1R6.path],
          sourceIds: [d1R6.sources[0]!.id],
        },
        {
          action: 'REFINE',
          path: 'digest/wiki/existing-ref.md',
          name: 'Existing Ref',
          description: 'Unrelated prose edit preserving pre-existing link',
          edits: [{ oldText: '原正文。', newText: '已更新的独立正文。' }],
          dailyPaths: [d1R6.path],
          sourceIds: [d1R6.sources[0]!.id],
        },
      ],
    })
  })
  await hR6.run()
  assert.equal(hR6.documents.read(d0R6.workspace, 'digest/wiki/indented-dep.md'), null, '4-leading-spaces CREATE referencing stripped profile draft must be stripped after trim (R6 P2-2)')
  const existingAfter = hR6.documents.read(d0R6.workspace, 'digest/wiki/existing-ref.md')!
  assert.ok(existingAfter.markdown.includes('已更新的独立正文。'), 'unrelated prose REFINE on doc with pre-existing profile link must NOT be discarded (R6 P2-2)')

  // R7 P2-1: REFINE edits[] must use ONE shared normalized body for both filtering and persistence:
  //   (a) editing an indented code example containing [[digest/personal/profile.MD]] must NOT trim leading spaces & discard it;
  //   (b) editing a body with a leading blank line before a YAML-shaped block linking [[digest/personal/profile.MD]] MUST strip it.
  const hR7 = dreamHarness(t, { initialNow: TODAY_MS })
  const d0R7 = hR7.addDailyNote([{ text: '缩进代码块与前导空行 YAML 测试文档' }], { session: 's-r7-p2-1-0', day: '2026-11-15' })
  hR7.documents.commit({
    operationId: randomUUID(),
    workspace: d0R7.workspace,
    path: 'digest/wiki/code-example.md',
    expectedRevision: null,
    action: 'CREATE',
    markdown: '---\nname: Code Example\ndescription: Indented code block at top\n---\n    // sample [[digest/personal/profile.MD]]\n    const v = 1\n',
    sources: [{ id: d0R7.sources[0]!.id, token: memorySourceToken(d0R7.sources[0]!) }],
    reads: [],
  })
  hR7.documents.commit({
    operationId: randomUUID(),
    workspace: d0R7.workspace,
    path: 'digest/wiki/blank-yaml.md',
    expectedRevision: null,
    action: 'CREATE',
    markdown: '---\nname: Blank Yaml\ndescription: Leading blank line before yaml-shaped block\n---\n\n---\nname: Fake\n---\nOriginal line.\n',
    sources: [{ id: d0R7.sources[0]!.id, token: memorySourceToken(d0R7.sources[0]!) }],
    reads: [],
  })
  hR7.notes.markProcessed(d0R7.key, d0R7.note.revision)
  const d1R7 = hR7.addDailyNote([{ text: '同时编辑缩进代码块和带前导空行 YAML 文档' }], { session: 's-r7-p2-1-1', day: '2026-11-16' })
  hR7.setModel(async request => {
    if (request.system === DREAM_PROFILE_SYSTEM) return JSON.stringify({ action: 'NOOP' })
    await request.tools!.executeTool({ callId: 'c1', name: 'read', input: { path: 'digest/wiki/code-example.md' } })
    await request.tools!.executeTool({ callId: 'c2', name: 'read', input: { path: 'digest/wiki/blank-yaml.md' } })
    return JSON.stringify({
      operations: [
        {
          action: 'CREATE',
          path: 'digest/personal/profile.MD',
          name: 'Bad Profile',
          description: 'Reserved draft to strip',
          body: '- bad profile draft',
          dailyPaths: [d1R7.path],
          sourceIds: [d1R7.sources[0]!.id],
        },
        {
          action: 'REFINE',
          path: 'digest/wiki/code-example.md',
          name: 'Code Example',
          description: 'Update indented code value',
          edits: [{ oldText: 'const v = 1', newText: 'const v = 2' }],
          dailyPaths: [d1R7.path],
          sourceIds: [d1R7.sources[0]!.id],
        },
        {
          action: 'REFINE',
          path: 'digest/wiki/blank-yaml.md',
          name: 'Blank Yaml',
          description: 'Inject link to stripped profile draft inside leading blank line + YAML-shaped block',
          edits: [{ oldText: 'name: Fake', newText: 'name: "[[digest/personal/profile.MD]]"' }],
          dailyPaths: [d1R7.path],
          sourceIds: [d1R7.sources[0]!.id],
        },
      ],
    })
  })
  await hR7.run()
  const codeAfter = hR7.documents.read(d0R7.workspace, 'digest/wiki/code-example.md')!
  assert.ok(codeAfter.markdown.includes('    const v = 2'), 'REFINE edits[] on indented code example must preserve leading spaces and NOT be discarded (R7 P2-1)')
  const blankYamlAfter = hR7.documents.read(d0R7.workspace, 'digest/wiki/blank-yaml.md')!
  assert.ok(!blankYamlAfter.markdown.includes('digest/personal/profile.MD'), 'REFINE edits[] injecting link inside leading-blank-line YAML block must be stripped (R7 P2-1, R8)')
  assert.ok(blankYamlAfter.markdown.includes('name: Fake'))
})

test('out-of-batch observed source becoming ineligible blocks digest commit, and NOOP checkpoint rejects observed note mutating during checkpoint load (R4 P1-2)', async t => {
  // Part A: out-of-batch observed daily note source becomes ineligible during profile pass -> digest must NOT commit!
  const ineligibleSources = new Set<string>()
  const hA = dreamHarness(t, { initialNow: TODAY_MS, eligible: src => !ineligibleSources.has(src.id) })
  const d0A = hA.addDailyNote([{ text: '历史背景：北京机房配置' }], { session: 's-r4-a0', day: '2026-11-15' })
  hA.notes.markProcessed(d0A.key, d0A.note.revision)
  const d1A = hA.addDailyNote([{ text: '基于背景做决策，我偏好蓝色主题' }], { session: 's-r4-a1', day: '2026-11-16' })
  hA.setModel(async request => {
    if (request.system === DREAM_PROFILE_SYSTEM) {
      // Session of out-of-batch note d0A starts a foreground turn -> d0A's source becomes ineligible!
      ineligibleSources.add(d0A.sources[0]!.id)
      return JSON.stringify({ action: 'NOOP' })
    }
    const readRes = await request.tools!.executeTool({ callId: 'c-d0', name: 'read', input: { path: d0A.path } })
    assert.equal(readRes.state, 'completed')
    assert.match(readRes.content, /北京机房配置/)
    return JSON.stringify({
      operations: [{
        action: 'CREATE',
        path: 'digest/wiki/beijing-ops.md',
        name: 'Beijing Ops',
        description: 'Derived from d0A',
        body: '北京机房运维记录',
        dailyPaths: [d1A.path],
        sourceIds: [d1A.sources[0]!.id],
      }],
    })
  })
  await hA.run()
  assert.equal(hA.documents.read(d0A.workspace, 'digest/wiki/beijing-ops.md'), null, 'digest must NOT commit when out-of-batch observed source became ineligible')
  assert.equal(hA.notes.changedFiles('2026-11-15', '2026-11-16').length, 1, 'd1A checkpoint must NOT advance when observed source became ineligible')

  // Part B (R5 P1-2a): After observed d0B's async loadFiles read returns and BEFORE the checkpoint transaction runs,
  // edit d0B on disk -> synchronous live-disk revalidation inside checkpoint transaction must reject stale checkpoint!
  let armInterleave = false
  let d0BAbsPath = ''
  let d0BPath = ''
  const hB = dreamHarness(t, {
    initialNow: TODAY_MS,
    async readPhysicalOverride(defaultRead, workspace, filePath, signal) {
      const res = await defaultRead(workspace, filePath, signal)
      if (armInterleave && filePath === d0BPath) {
        armInterleave = false
        fs.writeFileSync(d0BAbsPath, `${fs.readFileSync(d0BAbsPath, 'utf8')}\n<!-- interleaved edit after d0B read finished -->`)
      }
      return res
    },
  })
  const d0B = hB.addDailyNote([{ text: '旧日记：广州机房配置' }], { session: 's-r4-b0', day: '2026-11-15' })
  d0BPath = d0B.path
  d0BAbsPath = path.join(hB.store.fileRoot, d0B.workspace, d0B.path)
  hB.notes.markProcessed(d0B.key, d0B.note.revision)
  const d1B = hB.addDailyNote([{ text: '今天一切正常，无需新建摘要' }], { session: 's-r4-b1', day: '2026-11-16' })
  hB.setModel(async request => {
    if (request.system === DREAM_PROFILE_SYSTEM) {
      armInterleave = true
      return JSON.stringify({ action: 'NOOP' })
    }
    const readRes = await request.tools!.executeTool({ callId: 'c-d0b', name: 'read', input: { path: d0B.path } })
    assert.equal(readRes.state, 'completed')
    assert.match(readRes.content, /广州机房配置/)
    return JSON.stringify({ operations: [] })
  })
  await hB.run()
  assert.equal(armInterleave, false, 'interleaved edit must have triggered after d0B async read')
  assert.equal(hB.notes.changedFiles('2026-11-15', '2026-11-16').length, 1, 'NOOP must NOT advance d1B checkpoint when observed d0B was edited on disk after its loadFiles read finished (R5 P1-2)')

  // Part C (R5 P1-2b): Deferred target A retried while its observed source is temporarily ineligible must stay in
  // deferredCheckpoints AND NOT block independent target B or manual Dream completion!
  const ineligibleC = new Set<string>()
  let hideD0C = false
  let d0CPath = ''
  const hC = dreamHarness(t, {
    initialNow: TODAY_MS,
    eligible: src => !ineligibleC.has(src.id),
    async readPhysicalOverride(defaultRead, workspace, filePath, signal) {
      if (hideD0C && filePath === d0CPath) return null
      return defaultRead(workspace, filePath, signal)
    },
  })
  const d0C = hC.addDailyNote([{ text: '旧日记：深圳机房配置' }], { session: 's-r5-c0', day: '2026-11-15' })
  d0CPath = d0C.path
  hC.notes.markProcessed(d0C.key, d0C.note.revision)
  const dAC = hC.addDailyNote([{ text: '目标 A 无新建摘要' }], { session: 's-r5-ca', day: '2026-11-16' })
  hC.setModel(async request => {
    if (request.system === DREAM_PROFILE_SYSTEM) {
      // Make d0C unreadable right before checkpointTargets so A is deferred!
      hideD0C = true
      return JSON.stringify({ action: 'NOOP' })
    }
    const readRes = await request.tools!.executeTool({ callId: 'c-d0c', name: 'read', input: { path: d0C.path } })
    assert.equal(readRes.state, 'completed')
    return JSON.stringify({ operations: [] })
  })
  await hC.run()
  // A is now persisted in deferredCheckpoints! Restore d0C on disk, make d0C's source temporarily ineligible,
  // and add an independent healthy target B with a manual Dream request!
  hideD0C = false
  ineligibleC.add(d0C.sources[0]!.id)
  const dBC = hC.addDailyNote([{ text: '独立目标 B 正常整理完成' }], { session: 's-r5-cb', day: '2026-11-16' })
  hC.setModel(async request => {
    if (request.system === DREAM_PROFILE_SYSTEM) return JSON.stringify({ action: 'NOOP' })
    return JSON.stringify({ operations: [] })
  })
  const manualOpId = randomUUID()
  hC.jobs.request(manualOpId)
  await hC.retryNow()
  const manualStatus = hC.jobs.status(manualOpId)
  assert.ok(manualStatus.completedAt !== null, 'manual Dream request must complete for independent target B even when deferred target A waits on admission (R5 P1-2)')
  assert.ok(hC.notes.changedFiles('2026-11-15', '2026-11-16').every(f => f.key !== dBC.key), 'independent target B must be processed')
  assert.ok(hC.notes.changedFiles('2026-11-15', '2026-11-16').some(f => f.key === dAC.key), 'deferred target A must still be unprocessed while waiting')
  // Verify A's deferred checkpoint was NOT dropped: once d0C becomes eligible again, retry advances A with 0 new consolidate calls!
  ineligibleC.clear()
  // R6 P2-1: Make A's OWN source ineligible before retry -> A must STILL not advance while independent work proceeds!
  ineligibleC.add(dAC.sources[0]!.id)
  await hC.retryNow()
  assert.ok(hC.notes.changedFiles('2026-11-15', '2026-11-16').some(f => f.key === dAC.key), 'deferred NOOP A must NOT advance while its own source is ineligible (R6 P2-1)')
  ineligibleC.clear()
  let extraModelCalls = 0
  hC.setModel(async () => { extraModelCalls++; return JSON.stringify({ operations: [] }) })
  await hC.retryNow()
  assert.equal(hC.notes.changedFiles('2026-11-15', '2026-11-16').length, 0, 'deferred target A must advance once its observed source and own source are eligible again')
  assert.equal(extraModelCalls, 0, 'preserved deferred checkpoint A must finish without re-running consolidate model')

  // Part D (R6 P1): Moving an observed note AFTER async loadFiles read finishes and BEFORE final live check must
  // classify as unverifiable (keeping deferred checkpoint intact) rather than stale/replanning!
  let armMove = false
  let d0DAbs = ''
  let d0DBackup = ''
  let d0DPath = ''
  const hD = dreamHarness(t, {
    initialNow: TODAY_MS,
    async readPhysicalOverride(defaultRead, workspace, filePath, signal) {
      const res = await defaultRead(workspace, filePath, signal)
      if (armMove && filePath === d0DPath) {
        armMove = false
        fs.renameSync(d0DAbs, d0DBackup)
      }
      return res
    },
  })
  const d0D = hD.addDailyNote([{ text: '旧日记：杭州机房配置' }], { session: 's-r6-d0', day: '2026-11-15' })
  d0DPath = d0D.path
  d0DAbs = path.join(hD.store.fileRoot, d0D.workspace, d0D.path)
  d0DBackup = `${d0DAbs}.moved`
  hD.notes.markProcessed(d0D.key, d0D.note.revision)
  hD.addDailyNote([{ text: '目标 D 无新建摘要' }], { session: 's-r6-d1', day: '2026-11-16' })
  let modelCallsD = 0
  hD.setModel(async request => {
    modelCallsD++
    if (request.system === DREAM_PROFILE_SYSTEM) {
      armMove = true
      return JSON.stringify({ action: 'NOOP' })
    }
    const readRes = await request.tools!.executeTool({ callId: 'c-d0d', name: 'read', input: { path: d0D.path } })
    assert.equal(readRes.state, 'completed')
    return JSON.stringify({ operations: [] })
  })
  await hD.run()
  assert.equal(armMove, false, 'file move must have triggered after d0D async read')
  const callsAfterDefer = modelCallsD
  assert.equal(hD.notes.changedFiles('2026-11-15', '2026-11-16').length, 1, 'moved dependency during final live check must defer instead of marking processed')
  // Retry while still moved: must NOT replan or mark processed!
  await hD.retryNow()
  assert.equal(modelCallsD, callsAfterDefer, 'missing dependency must stay in deferredCheckpoints without replanning (R6 P1)')
  assert.equal(hD.notes.changedFiles('2026-11-15', '2026-11-16').length, 1)
  // Restore moved file -> deferred checkpoint completes with ZERO extra model calls!
  fs.renameSync(d0DBackup, d0DAbs)
  await hD.retryNow()
  assert.equal(modelCallsD, callsAfterDefer, 'restored dependency must complete deferred checkpoint with 0 extra model calls')
  assert.equal(hD.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)

  // Part E (R7 P1): Final live check must use ONE physical snapshot per file (moving the file right AFTER readFileAtCommit
  // returns must NOT trigger a second filesystem read in notes.read that misclassifies it as stale!).
  let d0EPath = ''
  let d0EAbs = ''
  let d0EBackup = ''
  let liveReadsOfD0E = 0
  let armMoveAfterSnapshot = false
  const hE = dreamHarness(t, {
    initialNow: TODAY_MS,
    readFileAtCommitOverride(defaultRead, workspace, filePath) {
      const snap = defaultRead(workspace, filePath)
      if (filePath === d0EPath) {
        liveReadsOfD0E++
        if (armMoveAfterSnapshot && snap) {
          armMoveAfterSnapshot = false
          fs.renameSync(d0EAbs, d0EBackup)
        }
      }
      return snap
    },
  })
  const d0E = hE.addDailyNote([{ text: '旧日记：成都机房配置' }], { session: 's-r7-e0', day: '2026-11-15' })
  d0EPath = d0E.path
  d0EAbs = path.join(hE.store.fileRoot, d0E.workspace, d0E.path)
  d0EBackup = `${d0EAbs}.moved`
  hE.notes.markProcessed(d0E.key, d0E.note.revision)
  hE.addDailyNote([{ text: '目标 E 无新建摘要' }], { session: 's-r7-e1', day: '2026-11-16' })
  hE.setModel(async request => {
    if (request.system === DREAM_PROFILE_SYSTEM) {
      armMoveAfterSnapshot = true
      return JSON.stringify({ action: 'NOOP' })
    }
    const readRes = await request.tools!.executeTool({ callId: 'c-d0e', name: 'read', input: { path: d0E.path } })
    assert.equal(readRes.state, 'completed')
    return JSON.stringify({ operations: [] })
  })
  await hE.run()
  assert.equal(liveReadsOfD0E, 1, 'final live check must open observed file only ONCE via readFileAtCommit (R7 P1)')
  assert.equal(armMoveAfterSnapshot, false, 'file move right after single snapshot must have fired')
  assert.equal(hE.notes.changedFiles('2026-11-15', '2026-11-16').length, 0, 'single physical snapshot must feed notes.read directly without a second disk open that would race and classify as stale (R7 P1)')
  fs.renameSync(d0EBackup, d0EAbs)

  // Part F (R8 P2-4): A runtime omitting optional readFileAtCommit (revision-only) must retain deferred recovery with 0 extra planner calls.
  let armMoveF = false
  let d0FPath = ''
  let d0FAbs = ''
  let d0FBackup = ''
  const hF = dreamHarness(t, {
    initialNow: TODAY_MS,
    omitReadFileAtCommit: true,
    async readPhysicalOverride(defaultRead, workspace, filePath, signal) {
      const res = await defaultRead(workspace, filePath, signal)
      if (armMoveF && filePath === d0FPath) {
        armMoveF = false
        fs.renameSync(d0FAbs, d0FBackup)
      }
      return res
    },
  })
  const d0F = hF.addDailyNote([{ text: '旧日记：西安机房配置' }], { session: 's-r8-f0', day: '2026-11-15' })
  d0FPath = d0F.path
  d0FAbs = path.join(hF.store.fileRoot, d0F.workspace, d0F.path)
  d0FBackup = `${d0FAbs}.moved`
  hF.notes.markProcessed(d0F.key, d0F.note.revision)
  hF.addDailyNote([{ text: '目标 F 无新建摘要' }], { session: 's-r8-f1', day: '2026-11-16' })
  let modelCallsF = 0
  hF.setModel(async request => {
    modelCallsF++
    if (request.system === DREAM_PROFILE_SYSTEM) {
      armMoveF = true
      return JSON.stringify({ action: 'NOOP' })
    }
    const readRes = await request.tools!.executeTool({ callId: 'c-d0f', name: 'read', input: { path: d0F.path } })
    assert.equal(readRes.state, 'completed')
    return JSON.stringify({ operations: [] })
  })
  await hF.run()
  const callsAfterDeferF = modelCallsF
  await hF.retryNow()
  assert.equal(modelCallsF, callsAfterDeferF, 'revision-only runtime omitting readFileAtCommit must preserve deferred checkpoint with 0 extra planner calls (R8 P2-4)')
  fs.renameSync(d0FBackup, d0FAbs)
  await hF.retryNow()
  assert.equal(modelCallsF, callsAfterDeferF)
  assert.equal(hF.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)

  // Part G (R9 P2-4): On a revision-only runtime, moving an observed note right AFTER readFileRevisionAtCommit confirms
  // the live hash matches must NOT reopen disk in notes.read (reuses checkpointBatch snapshot, 0 stale/replan).
  let d0GPath = ''
  let d0GAbs = ''
  let d0GBackup = ''
  let armMoveAfterRev = false
  const hG = dreamHarness(t, {
    initialNow: TODAY_MS,
    omitReadFileAtCommit: true,
    readFileRevisionAtCommitOverride(defaultRead, workspace, filePath) {
      const rev = defaultRead(workspace, filePath)
      if (armMoveAfterRev && filePath === d0GPath && rev) {
        armMoveAfterRev = false
        fs.renameSync(d0GAbs, d0GBackup)
      }
      return rev
    },
  })
  const d0G = hG.addDailyNote([{ text: '旧日记：南京机房配置' }], { session: 's-r9-g0', day: '2026-11-15' })
  d0GPath = d0G.path
  d0GAbs = path.join(hG.store.fileRoot, d0G.workspace, d0G.path)
  d0GBackup = `${d0GAbs}.moved`
  hG.notes.markProcessed(d0G.key, d0G.note.revision)
  hG.addDailyNote([{ text: '目标 G 无新建摘要' }], { session: 's-r9-g1', day: '2026-11-16' })
  hG.setModel(async request => {
    if (request.system === DREAM_PROFILE_SYSTEM) {
      armMoveAfterRev = true
      return JSON.stringify({ action: 'NOOP' })
    }
    const readRes = await request.tools!.executeTool({ callId: 'c-d0g', name: 'read', input: { path: d0G.path } })
    assert.equal(readRes.state, 'completed')
    return JSON.stringify({ operations: [] })
  })
  await hG.run()
  assert.equal(armMoveAfterRev, false, 'move right after revision check must have fired')
  assert.equal(hG.notes.changedFiles('2026-11-15', '2026-11-16').length, 0, 'revision-only live check must reuse checkpointBatch snapshot without reopening disk in notes.read (R9 P2-4)')
  fs.renameSync(d0GBackup, d0GAbs)

  // Part H (R10 P2-4): Revision-only runtime ALSO omitting optional readPhysicalFile (no checkpointBatch):
  // moving an observed note right after readFileRevisionAtCommit must classify as unverifiable (0 extra planner calls on retry).
  let d0HPath = ''
  let d0HAbs = ''
  let d0HBackup = ''
  let armMoveNoBatch = false
  const hH = dreamHarness(t, {
    initialNow: TODAY_MS,
    omitReadFileAtCommit: true,
    omitReadPhysicalFile: true,
    readFileRevisionAtCommitOverride(defaultRead, workspace, filePath) {
      const rev = defaultRead(workspace, filePath)
      if (armMoveNoBatch && filePath === d0HPath && rev) {
        armMoveNoBatch = false
        fs.renameSync(d0HAbs, d0HBackup)
      }
      return rev
    },
  })
  const d0H = hH.addDailyNote([{ text: '旧日记：武汉机房配置' }], { session: 's-r10-h0', day: '2026-11-15' })
  d0HPath = d0H.path
  d0HAbs = path.join(hH.store.fileRoot, d0H.workspace, d0H.path)
  d0HBackup = `${d0HAbs}.moved`
  hH.notes.markProcessed(d0H.key, d0H.note.revision)
  hH.addDailyNote([{ text: '目标 H 无新建摘要' }], { session: 's-r10-h1', day: '2026-11-16' })
  let modelCallsH = 0
  hH.setModel(async request => {
    modelCallsH++
    if (request.system === DREAM_PROFILE_SYSTEM) {
      armMoveNoBatch = true
      return JSON.stringify({ action: 'NOOP' })
    }
    const readRes = await request.tools!.executeTool({ callId: 'c-d0h', name: 'read', input: { path: d0H.path } })
    assert.equal(readRes.state, 'completed')
    return JSON.stringify({ operations: [] })
  })
  await hH.run()
  assert.equal(armMoveNoBatch, false, 'move right after revision check must have fired in no-batch mode')
  const callsAfterDeferH = modelCallsH
  assert.equal(hH.notes.changedFiles('2026-11-15', '2026-11-16').length, 1, 'no-batch missing note must defer instead of marking processed')
  await hH.retryNow()
  assert.equal(modelCallsH, callsAfterDeferH, 'no-batch revision-only runtime must preserve deferred checkpoint with 0 extra planner calls while file is absent (R10 P2-4)')
  fs.renameSync(d0HBackup, d0HAbs)
  await hH.retryNow()
  assert.equal(modelCallsH, callsAfterDeferH, 'restored file must complete deferred checkpoint with 0 extra planner calls (R10 P2-4)')
  assert.equal(hH.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)

  // Part I (R11 P2-3): Revision-only no-batch runtime where an observed digest becomes unreadable (EACCES) right after
  // readFileRevisionAtCommit matches -> documents.read throws -> caught as unverifiable -> deferred checkpoint preserved (0 extra planner calls!).
  if (process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)) {
    let docIAbs = ''
    let armChmod = false
    const hI = dreamHarness(t, {
      initialNow: TODAY_MS,
      omitReadFileAtCommit: true,
      omitReadPhysicalFile: true,
      readFileRevisionAtCommitOverride(defaultRead, workspace, filePath) {
        const rev = defaultRead(workspace, filePath)
        if (armChmod && filePath === 'digest/wiki/doc-i.md' && rev) {
          armChmod = false
          fs.chmodSync(docIAbs, 0o000)
        }
        return rev
      },
    })
    const d0I = hI.addDailyNote([{ text: '旧摘要来源：天津机房配置' }], { session: 's-r11-i0', day: '2026-11-15' })
    hI.documents.commit({
      operationId: randomUUID(),
      workspace: d0I.workspace,
      path: 'digest/wiki/doc-i.md',
      expectedRevision: null,
      action: 'CREATE',
      markdown: '---\nname: Doc I\ndescription: Observed digest for EACCES test\n---\n\n天津机房运维配置。\n',
      sources: [{ id: d0I.sources[0]!.id, token: memorySourceToken(d0I.sources[0]!) }],
      reads: [],
    })
    docIAbs = path.join(hI.store.fileRoot, d0I.workspace, 'digest/wiki/doc-i.md')
    t.after(() => { try { fs.chmodSync(docIAbs, 0o644) } catch { /* ignore */ } })
    hI.notes.markProcessed(d0I.key, d0I.note.revision)
    hI.addDailyNote([{ text: '目标 I 读取观察摘要后无需新建文档' }], { session: 's-r11-i1', day: '2026-11-16' })
    let modelCallsI = 0
    hI.setModel(async request => {
      modelCallsI++
      if (request.system === DREAM_PROFILE_SYSTEM) {
        armChmod = true
        return JSON.stringify({ action: 'NOOP' })
      }
      const readRes = await request.tools!.executeTool({ callId: 'c-doci', name: 'read', input: { path: 'digest/wiki/doc-i.md' } })
      assert.equal(readRes.state, 'completed')
      return JSON.stringify({ operations: [] })
    })
    await hI.run()
    assert.equal(armChmod, false, 'chmod 0o000 right after revision check must have fired')
    const callsAfterDeferI = modelCallsI
    assert.equal(callsAfterDeferI, 2, 'initial Dream run should make exactly 2 planner calls (consolidate + profile)')
    assert.equal(hI.notes.changedFiles('2026-11-15', '2026-11-16').length, 1, 'EACCES during observed digest read must defer instead of marking processed')
    await hI.retryNow()
    assert.equal(modelCallsI, callsAfterDeferI, 'deferred checkpoint must survive EACCES with 0 extra planner calls while unreadable (R11 P2-3)')
    fs.chmodSync(docIAbs, 0o644)
    await hI.retryNow()
    assert.equal(modelCallsI, callsAfterDeferI, 'restoring read access must complete deferred checkpoint with 0 extra planner calls (R11 P2-3)')
    assert.equal(hI.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)

    // Part J (R12 P2-1): Brief EACCES on observed daily note after first revision match, restored BEFORE any second revision check:
    // notes.read preserves the physical read error separately from a policy/revision mismatch -> defers -> 0 extra planner calls!
    let d0JPath = ''
    let d0JAbs = ''
    let revChecksJ = 0
    let armBriefChmod = false
    const hJ = dreamHarness(t, {
      initialNow: TODAY_MS,
      omitReadFileAtCommit: true,
      omitReadPhysicalFile: true,
      readFileRevisionAtCommitOverride(defaultRead, workspace, filePath) {
        if (filePath === d0JPath) {
          revChecksJ++
          if (revChecksJ === 2) {
            // Even if access is restored before any second check, the first notes.read EACCES must already have deferred!
            try { fs.chmodSync(d0JAbs, 0o644) } catch { /* ignore */ }
          }
        }
        const rev = defaultRead(workspace, filePath)
        if (armBriefChmod && filePath === d0JPath && rev) {
          armBriefChmod = false
          fs.chmodSync(d0JAbs, 0o000)
        }
        return rev
      },
    })
    const d0J = hJ.addDailyNote([{ text: '旧日记：重庆机房配置' }], { session: 's-r12-j0', day: '2026-11-15' })
    d0JPath = d0J.path
    d0JAbs = path.join(hJ.store.fileRoot, d0J.workspace, d0J.path)
    t.after(() => { try { fs.chmodSync(d0JAbs, 0o644) } catch { /* ignore */ } })
    hJ.notes.markProcessed(d0J.key, d0J.note.revision)
    hJ.addDailyNote([{ text: '目标 J 无新建摘要' }], { session: 's-r12-j1', day: '2026-11-16' })
    let modelCallsJ = 0
    hJ.setModel(async request => {
      modelCallsJ++
      if (request.system === DREAM_PROFILE_SYSTEM) {
        armBriefChmod = true
        return JSON.stringify({ action: 'NOOP' })
      }
      const readRes = await request.tools!.executeTool({ callId: 'c-d0j', name: 'read', input: { path: d0J.path } })
      assert.equal(readRes.state, 'completed')
      return JSON.stringify({ operations: [] })
    })
    await hJ.run()
    assert.equal(armBriefChmod, false)
    assert.equal(modelCallsJ, 2)
    assert.equal(hJ.notes.changedFiles('2026-11-15', '2026-11-16').length, 1, 'brief note EACCES must defer instead of discarding checkpoint as stale (R12 P2-1)')
    fs.chmodSync(d0JAbs, 0o644)
    await hJ.retryNow()
    assert.equal(modelCallsJ, 2, 'restoring note access must finish deferred checkpoint with 0 extra planner calls (2 total, not 4) (R12 P2-1)')
    assert.equal(hJ.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
  }

  // Part K (R12 P2-2): Malformed source-reference metadata JSON for an observed digest after revision matches must NOT be
  // swallowed as unverifiable — it must propagate to the job error handler and keep the manual Dream request pending!
  let armCorruptK = false
  let corruptWorkspaceK = ''
  const hK = dreamHarness(t, {
    initialNow: TODAY_MS,
    omitReadFileAtCommit: true,
    omitReadPhysicalFile: true,
    readFileRevisionAtCommitOverride(defaultRead, workspace, filePath) {
      const rev = defaultRead(workspace, filePath)
      if (armCorruptK && filePath === 'digest/wiki/doc-k.md' && rev) {
        armCorruptK = false
        hK.store.db.prepare('UPDATE memory_documents SET sources = ? WHERE workspace = ? AND path = ?')
          .run('{malformed-json', corruptWorkspaceK, 'digest/wiki/doc-k.md')
      }
      return rev
    },
  })
  const d0K = hK.addDailyNote([{ text: '旧摘要来源：苏州机房配置' }], { session: 's-r12-k0', day: '2026-11-15' })
  corruptWorkspaceK = d0K.workspace
  hK.documents.commit({
    operationId: randomUUID(),
    workspace: d0K.workspace,
    path: 'digest/wiki/doc-k.md',
    expectedRevision: null,
    action: 'CREATE',
    markdown: '---\nname: Doc K\ndescription: Observed digest for metadata decode failure test\n---\n\n苏州机房运维配置。\n',
    sources: [{ id: d0K.sources[0]!.id, token: memorySourceToken(d0K.sources[0]!) }],
    reads: [],
  })
  hK.notes.markProcessed(d0K.key, d0K.note.revision)
  hK.addDailyNote([{ text: '目标 K 读取观察摘要' }], { session: 's-r12-k1', day: '2026-11-16' })
  hK.setModel(async request => {
    if (request.system === DREAM_PROFILE_SYSTEM) {
      armCorruptK = true
      return JSON.stringify({ action: 'NOOP' })
    }
    const readRes = await request.tools!.executeTool({ callId: 'c-dock', name: 'read', input: { path: 'digest/wiki/doc-k.md' } })
    assert.equal(readRes.state, 'completed')
    return JSON.stringify({ operations: [] })
  })
  const manualOpK = randomUUID()
  hK.jobs.request(manualOpK)
  await hK.effects.wake()
  assert.equal(armCorruptK, false, 'metadata corruption after revision check must have fired')
  const statusK = hK.jobs.status(manualOpK)
  assert.equal(statusK.completedAt, null, 'metadata decoding failure must NOT produce a successful manual completion receipt (R12 P2-2)')
  assert.notEqual(statusK.state, 'idle', 'job must enter retry state rather than idle/empty on metadata decoding error (R12 P2-2)')

  // Part L (R13 P2-1): No-batch revision-only runtime must reuse the strict read's snapshot for policy validation
  // without reopening the target note a second time (moving/denying access after strict read cannot misclassify as stale).
  const hL = dreamHarness(t, { initialNow: TODAY_MS, omitReadFileAtCommit: true, omitReadPhysicalFile: true })
  const d1L = hL.addDailyNote([{ text: '目标 L 单次严格读取后直接复用快照' }], { session: 's-r13-l1', day: '2026-11-16' })
  const d1LAbs = path.join(hL.store.fileRoot, d1L.workspace, d1L.path)
  const d1LBackup = `${d1LAbs}.moved`
  let strictReadsL = 0
  const origNotesReadL = hL.notes.read
  hL.notes.read = (key, physical, opts) => {
    const res = origNotesReadL(key, physical, opts)
    if (key === d1L.key && opts?.throwOnPhysicalError && res) {
      strictReadsL++
      // Remove the file right AFTER the strict read succeeds; policy validation must use the snapshot without reopening disk!
      fs.renameSync(d1LAbs, d1LBackup)
    }
    return res
  }
  let modelCallsL = 0
  hL.setModel(async request => {
    modelCallsL++
    if (request.system === DREAM_PROFILE_SYSTEM) return JSON.stringify({ action: 'NOOP' })
    return JSON.stringify({ operations: [] })
  })
  await hL.run()
  assert.equal(strictReadsL, 1, 'strict read of target note must have fired once')
  assert.equal(modelCallsL, 2)
  assert.equal(hL.notes.changedFiles('2026-11-15', '2026-11-16').length, 0, 'target note checkpoint must reuse strict read snapshot without reopening disk (R13 P2-1)')
  fs.renameSync(d1LBackup, d1LAbs)

  // Part M (R13 P2-2): Briefly missing observed note (ENOENT) restored before any second revision check must still defer (0 extra planner calls).
  let d0MPath = ''
  let d0MAbs = ''
  let d0MBackup = ''
  let revChecksM = 0
  let armBriefMoveM = false
  const hM = dreamHarness(t, {
    initialNow: TODAY_MS,
    omitReadFileAtCommit: true,
    omitReadPhysicalFile: true,
    readFileRevisionAtCommitOverride(defaultRead, workspace, filePath) {
      if (filePath === d0MPath) {
        revChecksM++
        if (revChecksM === 2 && fs.existsSync(d0MBackup)) {
          fs.renameSync(d0MBackup, d0MAbs)
        }
      }
      const rev = defaultRead(workspace, filePath)
      if (armBriefMoveM && filePath === d0MPath && rev) {
        armBriefMoveM = false
        fs.renameSync(d0MAbs, d0MBackup)
      }
      return rev
    },
  })
  const d0M = hM.addDailyNote([{ text: '旧日记：厦门机房配置' }], { session: 's-r13-m0', day: '2026-11-15' })
  d0MPath = d0M.path
  d0MAbs = path.join(hM.store.fileRoot, d0M.workspace, d0M.path)
  d0MBackup = `${d0MAbs}.moved`
  hM.notes.markProcessed(d0M.key, d0M.note.revision)
  hM.addDailyNote([{ text: '目标 M 无新建摘要' }], { session: 's-r13-m1', day: '2026-11-16' })
  let modelCallsM = 0
  hM.setModel(async request => {
    modelCallsM++
    if (request.system === DREAM_PROFILE_SYSTEM) {
      armBriefMoveM = true
      return JSON.stringify({ action: 'NOOP' })
    }
    const readRes = await request.tools!.executeTool({ callId: 'c-d0m', name: 'read', input: { path: d0M.path } })
    assert.equal(readRes.state, 'completed')
    return JSON.stringify({ operations: [] })
  })
  await hM.run()
  assert.equal(armBriefMoveM, false)
  assert.equal(modelCallsM, 2)
  assert.equal(hM.notes.changedFiles('2026-11-15', '2026-11-16').length, 1, 'briefly missing observed note must defer instead of classifying as stale (R13 P2-2)')
  if (fs.existsSync(d0MBackup)) fs.renameSync(d0MBackup, d0MAbs)
  await hM.retryNow()
  assert.equal(modelCallsM, 2, 'restoring briefly missing note must complete deferred checkpoint with 0 extra planner calls (R13 P2-2)')
  assert.equal(hM.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)

  // Part N (R13 P2-3): Temporarily replacing an observed note with a directory (MemoryFileError('not-file')) must defer and keep checkpoint intact!
  let d0NPath = ''
  let d0NAbs = ''
  let d0NBackup = ''
  let armDirSwapN = false
  const hN = dreamHarness(t, {
    initialNow: TODAY_MS,
    omitReadFileAtCommit: true,
    omitReadPhysicalFile: true,
    readFileRevisionAtCommitOverride(defaultRead, workspace, filePath) {
      const rev = defaultRead(workspace, filePath)
      if (armDirSwapN && filePath === d0NPath && rev) {
        armDirSwapN = false
        fs.renameSync(d0NAbs, d0NBackup)
        fs.mkdirSync(d0NAbs)
      }
      return rev
    },
  })
  const d0N = hN.addDailyNote([{ text: '旧日记：青岛机房配置' }], { session: 's-r13-n0', day: '2026-11-15' })
  d0NPath = d0N.path
  d0NAbs = path.join(hN.store.fileRoot, d0N.workspace, d0N.path)
  d0NBackup = `${d0NAbs}.orig`
  t.after(() => {
    try {
      if (fs.existsSync(d0NBackup)) {
        fs.rmSync(d0NAbs, { recursive: true, force: true })
        fs.renameSync(d0NBackup, d0NAbs)
      }
    } catch { /* ignore */ }
  })
  hN.notes.markProcessed(d0N.key, d0N.note.revision)
  hN.addDailyNote([{ text: '目标 N 无新建摘要' }], { session: 's-r13-n1', day: '2026-11-16' })
  let modelCallsN = 0
  hN.setModel(async request => {
    modelCallsN++
    if (request.system === DREAM_PROFILE_SYSTEM) {
      armDirSwapN = true
      return JSON.stringify({ action: 'NOOP' })
    }
    const readRes = await request.tools!.executeTool({ callId: 'c-d0n', name: 'read', input: { path: d0N.path } })
    assert.equal(readRes.state, 'completed')
    return JSON.stringify({ operations: [] })
  })
  await hN.run()
  assert.equal(armDirSwapN, false)
  assert.equal(modelCallsN, 2)
  assert.equal(hN.notes.changedFiles('2026-11-15', '2026-11-16').length, 1, 'non-regular file (directory) at observed note path must defer instead of aborting checkpoint persistence (R13 P2-3)')
  // Restore original regular file -> completes with 0 extra planner calls (2 total, not 4)!
  fs.rmSync(d0NAbs, { recursive: true, force: true })
  fs.renameSync(d0NBackup, d0NAbs)
  await hN.retryNow()
  assert.equal(modelCallsN, 2, 'restoring regular file after directory swap must complete deferred checkpoint with 0 extra planner calls (R13 P2-3)')
  assert.equal(hN.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)

  // Part O (R14 P2-1): On a no-batch runtime, changing the target note on disk WHILE Dream validates a distinct observed
  // dependency must be caught by target's single live check immediately before markProcessed (kept pending, NOT processed).
  let d0OPath = ''
  let d1OAbs = ''
  let armMutateTargetO = false
  const hO = dreamHarness(t, {
    initialNow: TODAY_MS,
    omitReadFileAtCommit: true,
    omitReadPhysicalFile: true,
    readFileRevisionAtCommitOverride(defaultRead, workspace, filePath) {
      const rev = defaultRead(workspace, filePath)
      if (armMutateTargetO && filePath === d0OPath) {
        armMutateTargetO = false
        fs.writeFileSync(d1OAbs, `${fs.readFileSync(d1OAbs, 'utf8')}\n<!-- target edited during distinct obs validation -->`)
      }
      return rev
    },
  })
  const d0O = hO.addDailyNote([{ text: '旧日记：大连机房配置' }], { session: 's-r14-o0', day: '2026-11-15' })
  d0OPath = d0O.path
  hO.notes.markProcessed(d0O.key, d0O.note.revision)
  const d1O = hO.addDailyNote([{ text: '目标 O 读取 d0O 后无需新建文档' }], { session: 's-r14-o1', day: '2026-11-16' })
  d1OAbs = path.join(hO.store.fileRoot, d1O.workspace, d1O.path)
  hO.setModel(async request => {
    if (request.system === DREAM_PROFILE_SYSTEM) {
      armMutateTargetO = true
      return JSON.stringify({ action: 'NOOP' })
    }
    const readRes = await request.tools!.executeTool({ callId: 'c-d0o', name: 'read', input: { path: d0O.path } })
    assert.equal(readRes.state, 'completed')
    return JSON.stringify({ operations: [] })
  })
  await hO.run()
  assert.equal(armMutateTargetO, false, 'target mutation during distinct observed note check must have fired')
  assert.equal(hO.notes.changedFiles('2026-11-15', '2026-11-16').length, 1, 'target note changed during distinct dependency check must remain pending, NOT marked processed (R14 P2-1)')

  // Part P (R14 P2-2): Target note that the planner also reads (in observedNotes) must be physically validated ONLY ONCE
  // (1 revision check + 1 strict read total); moving it after that single strict read must still complete cleanly.
  let d1PPath = ''
  let d1PAbs = ''
  let d1PBackup = ''
  let revChecksP = 0
  let strictReadsP = 0
  const hP = dreamHarness(t, {
    initialNow: TODAY_MS,
    omitReadFileAtCommit: true,
    omitReadPhysicalFile: true,
    readFileRevisionAtCommitOverride(defaultRead, workspace, filePath) {
      if (filePath === d1PPath) revChecksP++
      return defaultRead(workspace, filePath)
    },
  })
  const d1P = hP.addDailyNote([{ text: '目标 P 同时被规划器自身 read 读取' }], { session: 's-r14-p1', day: '2026-11-16' })
  d1PPath = d1P.path
  d1PAbs = path.join(hP.store.fileRoot, d1P.workspace, d1P.path)
  d1PBackup = `${d1PAbs}.moved`
  const origReadP = hP.notes.read
  hP.notes.read = (key, physical, opts) => {
    const res = origReadP(key, physical, opts)
    if (key === d1P.key && opts?.throwOnPhysicalError && res) {
      strictReadsP++
      fs.renameSync(d1PAbs, d1PBackup)
    }
    return res
  }
  hP.setModel(async request => {
    if (request.system === DREAM_PROFILE_SYSTEM) return JSON.stringify({ action: 'NOOP' })
    const readRes = await request.tools!.executeTool({ callId: 'c-self', name: 'read', input: { path: d1P.path } })
    assert.equal(readRes.state, 'completed')
    return JSON.stringify({ operations: [] })
  })
  await hP.run()
  assert.equal(revChecksP, 1, 'self-observed target note must run only 1 revision check (R14 P2-2)')
  assert.equal(strictReadsP, 1, 'self-observed target note must run only 1 strict read (R14 P2-2)')
  assert.equal(hP.notes.changedFiles('2026-11-15', '2026-11-16').length, 0, 'self-observed target note must complete cleanly using its single physical observation (R14 P2-2)')
  fs.renameSync(d1PBackup, d1PAbs)

  // Part Q (R14 P2-3, R15 P2-1, R16 P2-3): Persistently malformed memory_documents.sources committed OUTSIDE the
  // checkpoint transaction must propagate through strict candidate-scan policy reads on retry with 0 extra planner calls
  // and keep the manual Dream request pending on both batch and no-batch runtimes!
  for (const omitPhysical of [true, false]) {
    const hQ = dreamHarness(t, {
      initialNow: TODAY_MS,
      omitReadFileAtCommit: omitPhysical,
      omitReadPhysicalFile: omitPhysical,
    })
    const d0Q = hQ.addDailyNote([{ text: '旧摘要来源：合肥机房配置' }], { session: `s-r16-q0-${omitPhysical}`, day: '2026-11-15' })
    hQ.documents.commit({
      operationId: randomUUID(),
      workspace: d0Q.workspace,
      path: 'digest/wiki/doc-q.md',
      expectedRevision: null,
      action: 'CREATE',
      markdown: '---\nname: Doc Q\ndescription: Digest whose sources JSON is corrupted persistently\n---\n\n合肥机房运维配置。\n',
      sources: [{ id: d0Q.sources[0]!.id, token: memorySourceToken(d0Q.sources[0]!) }],
      reads: [],
    })
    hQ.notes.markProcessed(d0Q.key, d0Q.note.revision)
    const d1Q = hQ.addDailyNote([{ text: `目标 Q 关联 [[digest/wiki/doc-q.md]] (${omitPhysical})` }], { session: `s-r16-q1-${omitPhysical}`, day: '2026-11-16' })
    let modelCallsQ = 0
    hQ.setModel(async request => {
      modelCallsQ++
      if (request.system === DREAM_PROFILE_SYSTEM) {
        // Persist malformed memory_documents.sources OUTSIDE the checkpoint transaction so rollback never undoes it!
        hQ.store.db.prepare('UPDATE memory_documents SET sources = ? WHERE workspace = ? AND path = ?')
          .run('{malformed-json', d0Q.workspace, 'digest/wiki/doc-q.md')
        return JSON.stringify({ action: 'NOOP' })
      }
      const readRes = await request.tools!.executeTool({ callId: 'c-docq', name: 'read', input: { path: 'digest/wiki/doc-q.md' } })
      assert.equal(readRes.state, 'completed')
      return JSON.stringify({ operations: [] })
    })
    const manualOpQ = randomUUID()
    hQ.jobs.request(manualOpQ)
    await hQ.effects.wake()
    assert.equal(modelCallsQ, 2)
    const statusQ1 = hQ.jobs.status(manualOpQ)
    assert.equal(statusQ1.completedAt, null, `first failure must NOT emit completedAt receipt (omitPhysical=${omitPhysical}) (R14 P2-3)`)
    assert.notEqual(statusQ1.state, 'idle')
    // Retry with the persistent corruption still in memory_documents.sources: candidate scan readStrict must fail
    // BEFORE running the planner (0 extra planner calls, manual request still pending)!
    await hQ.retryNow()
    assert.equal(modelCallsQ, 2, `retry with persistent malformed memory_documents.sources must fail in candidate scan without another planner call (omitPhysical=${omitPhysical}) (R16 P2-3)`)
    const statusQ2 = hQ.jobs.status(manualOpQ)
    assert.equal(statusQ2.completedAt, null, `retry with persistent metadata corruption must NOT emit completedAt/empty receipt (omitPhysical=${omitPhysical}) (R15 P2-1, R16 P2-3)`)
    assert.notEqual(statusQ2.state, 'idle')
    assert.equal(hQ.notes.changedFiles('2026-11-15', '2026-11-16').some(f => f.key === d1Q.key), true)
  }

  // Part R (R15 P2-2, R16 P2-2): Missing target + temporarily ineligible dependency must defer on BOTH batch AND
  // no-batch revision-only runtimes (saving deferred checkpoint and finishing with 2 total planner calls, NOT 4).
  for (const noBatch of [false, true]) {
    const ineligibleR = new Set<string>()
    let d1RPath = ''
    let d1RAbs = ''
    let d1RBackup = ''
    let d0RSourceId = ''
    let armCheckpointR = false
    let postProfileReadsOfD1R = 0
    const hR = dreamHarness(t, {
      initialNow: TODAY_MS,
      omitReadFileAtCommit: noBatch,
      omitReadPhysicalFile: noBatch,
      eligible: src => !ineligibleR.has(src.id),
      async readPhysicalOverride(defaultRead, workspace, filePath, signal) {
        if (!noBatch && armCheckpointR && filePath === d1RPath) {
          postProfileReadsOfD1R++
          if (postProfileReadsOfD1R === 2) {
            armCheckpointR = false
            fs.renameSync(d1RAbs, d1RBackup)
            ineligibleR.add(d0RSourceId)
          }
        }
        return defaultRead(workspace, filePath, signal)
      },
      readFileRevisionAtCommitOverride(defaultRead, workspace, filePath) {
        if (noBatch && armCheckpointR && filePath === 'digest/wiki/doc-r.md') {
          armCheckpointR = false
          fs.renameSync(d1RAbs, d1RBackup)
          ineligibleR.add(d0RSourceId)
        }
        return defaultRead(workspace, filePath)
      },
    })
    const d0R = hR.addDailyNote([{ text: `旧摘要来源：宁波机房配置 (${noBatch})` }], { session: `s-r15-r0-${noBatch}`, day: '2026-11-15' })
    d0RSourceId = d0R.sources[0]!.id
    hR.documents.commit({
      operationId: randomUUID(),
      workspace: d0R.workspace,
      path: 'digest/wiki/doc-r.md',
      expectedRevision: null,
      action: 'CREATE',
      markdown: '---\nname: Doc R\ndescription: Observed digest for ineligible + missing target test\n---\n\n宁波机房运维配置。\n',
      sources: [{ id: d0R.sources[0]!.id, token: memorySourceToken(d0R.sources[0]!) }],
      reads: [],
    })
    hR.notes.markProcessed(d0R.key, d0R.note.revision)
    const d1R = hR.addDailyNote([{ text: `目标 R 读取 doc-r 后缺失且依赖暂不可入场 (${noBatch})` }], { session: `s-r15-r1-${noBatch}`, day: '2026-11-16' })
    d1RPath = d1R.path
    d1RAbs = path.join(hR.store.fileRoot, d1R.workspace, d1R.path)
    d1RBackup = `${d1RAbs}.moved`
    let modelCallsR = 0
    hR.setModel(async request => {
      modelCallsR++
      if (request.system === DREAM_PROFILE_SYSTEM) {
        armCheckpointR = true
        return JSON.stringify({ action: 'NOOP' })
      }
      const readRes = await request.tools!.executeTool({ callId: 'c-docr', name: 'read', input: { path: 'digest/wiki/doc-r.md' } })
      assert.equal(readRes.state, 'completed')
      return JSON.stringify({ operations: [] })
    })
    const manualOpR = randomUUID()
    hR.jobs.request(manualOpR)
    await hR.effects.wake()
    assert.equal(armCheckpointR, false, `target move + dependency ineligibility must have triggered (noBatch=${noBatch})`)
    assert.equal(modelCallsR, 2)
    assert.ok(hR.jobs.status(manualOpR).completedAt !== null, `manual request must complete while missing target is deferred (noBatch=${noBatch}) (R15 P2-2, R16 P2-2)`)
    assert.equal(hR.notes.changedFiles('2026-11-15', '2026-11-16').length, 1)
    fs.renameSync(d1RBackup, d1RAbs)
    ineligibleR.clear()
    await hR.retryNow()
    assert.equal(modelCallsR, 2, `missing target deferred before dependency wait must finish with 0 extra planner calls (noBatch=${noBatch}) (R15 P2-2, R16 P2-2)`)
    assert.equal(hR.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
  }

  // Part R2 (R16 P2-1): A deferred target whose on-disk bytes changed while its observed digest source is ineligible
  // MUST be dropped immediately (restoring original bytes later must NOT advance the old plan without replanning!).
  const ineligibleR2 = new Set<string>()
  let armDeferR2 = false
  let postProfileReadsR2 = 0
  let d1R2Path = ''
  const hR2 = dreamHarness(t, {
    initialNow: TODAY_MS,
    eligible: src => !ineligibleR2.has(src.id),
    async readPhysicalOverride(defaultRead, workspace, filePath, signal) {
      if (armDeferR2 && filePath === d1R2Path) {
        postProfileReadsR2++
        if (postProfileReadsR2 === 2) {
          armDeferR2 = false
          return null
        }
      }
      return defaultRead(workspace, filePath, signal)
    },
  })
  const d0R2 = hR2.addDailyNote([{ text: '旧摘要来源：长沙机房配置' }], { session: 's-r16-r20', day: '2026-11-15' })
  hR2.documents.commit({
    operationId: randomUUID(),
    workspace: d0R2.workspace,
    path: 'digest/wiki/doc-r2.md',
    expectedRevision: null,
    action: 'CREATE',
    markdown: '---\nname: Doc R2\ndescription: Observed digest for deferred mismatch test\n---\n\n长沙机房运维配置。\n',
    sources: [{ id: d0R2.sources[0]!.id, token: memorySourceToken(d0R2.sources[0]!) }],
    reads: [],
  })
  hR2.notes.markProcessed(d0R2.key, d0R2.note.revision)
  const d1R2 = hR2.addDailyNote([{ text: '目标 R2 延迟后发生内容变更' }], { session: 's-r16-r21', day: '2026-11-16' })
  d1R2Path = d1R2.path
  const d1R2Abs = path.join(hR2.store.fileRoot, d1R2.workspace, d1R2.path)
  const originalBytesR2 = fs.readFileSync(d1R2Abs, 'utf8')
  let modelCallsR2 = 0
  hR2.setModel(async request => {
    modelCallsR2++
    if (request.system === DREAM_PROFILE_SYSTEM) {
      if (modelCallsR2 === 2) armDeferR2 = true
      return JSON.stringify({ action: 'NOOP' })
    }
    const readRes = await request.tools!.executeTool({ callId: 'c-docr2', name: 'read', input: { path: 'digest/wiki/doc-r2.md' } })
    assert.equal(readRes.state, 'completed')
    return JSON.stringify({ operations: [] })
  })
  await hR2.run()
  assert.equal(armDeferR2, false, 'd1R2 must have been deferred on initial checkpoint load')
  assert.equal(modelCallsR2, 2)
  assert.equal(hR2.notes.changedFiles('2026-11-15', '2026-11-16').length, 1, 'd1R2 must be deferred')
  // Now modify d1R2 on disk AND make d0R2's source ineligible before deferred retry!
  fs.writeFileSync(d1R2Abs, `${originalBytesR2}\n<!-- modified bytes -->`)
  ineligibleR2.add(d0R2.sources[0]!.id)
  await hR2.retryNow()
  // The batch observed the changed revision -> old deferred checkpoint MUST have been dropped!
  // Now restore original bytes & eligibility -> a fresh Dream run MUST replan (modelCallsR2 === 4, NOT 2)!
  fs.writeFileSync(d1R2Abs, originalBytesR2)
  ineligibleR2.clear()
  await hR2.run()
  assert.equal(modelCallsR2, 4, 'observed target revision mismatch during dependency wait must drop the deferred checkpoint so restoring original bytes requires replanning (R16 P2-1)')
  assert.equal(hR2.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)

  // Part S (R15 P2-3): Caller omitting BOTH readFileAtCommit AND readFileRevisionAtCommit (plus readPhysicalFile):
  // moving target immediately before strict read must defer (0 extra planner calls after restore).
  const hS = dreamHarness(t, {
    initialNow: TODAY_MS,
    omitReadFileAtCommit: true,
    omitReadFileRevisionAtCommit: true,
    omitReadPhysicalFile: true,
  })
  const d1S = hS.addDailyNote([{ text: '目标 S 省略两个 commit reader 时的物理读错恢复' }], { session: 's-r15-s1', day: '2026-11-16' })
  const d1SAbs = path.join(hS.store.fileRoot, d1S.workspace, d1S.path)
  const d1SBackup = `${d1SAbs}.moved`
  let armMoveS = false
  const origReadS = hS.notes.read
  hS.notes.read = (key, physical, opts) => {
    if (armMoveS && key === d1S.key && opts?.throwOnPhysicalError) {
      armMoveS = false
      fs.renameSync(d1SAbs, d1SBackup)
    }
    return origReadS(key, physical, opts)
  }
  let modelCallsS = 0
  hS.setModel(async request => {
    modelCallsS++
    if (request.system === DREAM_PROFILE_SYSTEM) {
      armMoveS = true
      return JSON.stringify({ action: 'NOOP' })
    }
    return JSON.stringify({ operations: [] })
  })
  await hS.run()
  assert.equal(armMoveS, false, 'target move immediately before strict read must have fired')
  assert.equal(modelCallsS, 2)
  assert.equal(hS.notes.changedFiles('2026-11-15', '2026-11-16').length, 1, 'physical read error with both commit readers omitted must defer instead of throwing (R15 P2-3)')
  fs.renameSync(d1SBackup, d1SAbs)
  await hS.retryNow()
  assert.equal(modelCallsS, 2, 'restoring target with both commit readers omitted must complete deferred checkpoint with 0 extra planner calls (R15 P2-3)')
  assert.equal(hS.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
})
