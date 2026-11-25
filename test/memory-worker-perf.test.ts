import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { createRemoteMemoryChannel } from '../src/backend/remote-memory-channel.ts'
import { createVivaMemoryClient } from '../src/backend/memory-client.ts'
import type { MemoryOwnerProfile } from '../src/memory/contracts/host.ts'
import { createMemoryDreamJobs } from '../src/memory/core/memory-dream-jobs.ts'
import { DREAM_PROFILE_SYSTEM } from '../src/memory/core/memory-dream-prompts.ts'
import { createMemoryRuntime } from '../src/memory/core/memory-runtime.ts'
import type { MemoryPhysicalFile } from '../src/memory/core/ports/documents.ts'
import { RESIDENT_PROFILE_PATH, userWorkspaceId } from '../src/memory/core/resident-profile.ts'
import { createEffects } from '../src/memory/node/effects.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { createMemoryPhysicalFileReader, MemoryFileError, openMemoryFileStore, readMemoryFileAtCommit } from '../src/memory/node/memory-file-store.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { memoryHash, openMemoryStore } from '../src/memory/node/memory-store.ts'
import { createMemoryOwnerSupervisor } from '../src/memory/node/owner-supervisor.ts'
import { openMemoryRuntimeResources } from '../src/memory/node/runtime.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'

function scratch(t: TestContext, prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const cleanups: Array<() => void | Promise<void>> = []
  t.after(async () => {
    for (const fn of cleanups.reverse()) {
      try { await fn() } catch { /* ignore cleanup error */ }
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, defer: (fn: () => void | Promise<void>) => cleanups.push(fn) }
}

test('readMemoryFileAtCommit reuses cached physical snapshot when live stat matches and invalidates on edits/moves', async t => {
  const { dir, defer } = scratch(t, 'mem-perf-stat-')
  const workspace = memoryHash('perf-stat-ws')
  const filePath = 'digest/wiki/alpha.md'
  const store = openMemoryFileStore(path.join(dir, workspace))
  store.write(filePath, '---\nname: Alpha\n---\n\nInitial content.\n', null)

  const reader = createMemoryPhysicalFileReader(() => dir)
  defer(() => reader.close())
  const initial = await reader(workspace, filePath)
  assert.ok(initial, 'async reader must return physical snapshot')

  // Unchanged file: must reuse the exact cached object without re-reading/re-hashing.
  const fast = readMemoryFileAtCommit(dir, workspace, filePath, initial)
  assert.strictEqual(fast, initial, 'matching stat must reuse cached MemoryPhysicalFile reference')

  // Modified file on disk: must detect stat change and re-read fresh bytes + revision.
  const absPath = path.join(dir, workspace, filePath)
  fs.writeFileSync(absPath, '---\nname: Alpha\n---\n\nUpdated content on disk.\n')
  const refreshed = readMemoryFileAtCommit(dir, workspace, filePath, initial)
  assert.ok(refreshed)
  assert.notStrictEqual(refreshed, initial)
  assert.notEqual(refreshed.revision, initial.revision)
  assert.match(refreshed.markdown, /Updated content on disk/)
  assert.strictEqual(readMemoryFileAtCommit(dir, workspace, filePath, refreshed), refreshed)

  // Replaced with directory -> MemoryFileError('not-file'); removed -> null.
  fs.unlinkSync(absPath)
  assert.equal(readMemoryFileAtCommit(dir, workspace, filePath, refreshed), null)
  fs.mkdirSync(absPath)
  assert.throws(
    () => readMemoryFileAtCommit(dir, workspace, filePath, refreshed),
    error => error instanceof MemoryFileError && error.code === 'not-file',
  )
})

test('residentProfileText skips disk when absent, reuses cached stat+projection on unrelated changes, and invalidates on edits', t => {
  const { dir, defer } = scratch(t, 'mem-perf-profile-cache-')
  const store = openMemoryStore(path.join(dir, 'memory.db'))
  defer(() => store.close())
  const baseResources = openMemoryRuntimeResources({ store })
  defer(() => baseResources.effects.close())

  const commitCalls: Array<{ path: string, hadCached: boolean, reused: boolean }> = []
  const resources = {
    ...baseResources,
    readFileAtCommit(workspace: string, filePath: string, cached?: MemoryPhysicalFile) {
      const result = baseResources.readFileAtCommit!(workspace, filePath, cached)
      commitCalls.push({ path: filePath, hadCached: Boolean(cached), reused: Boolean(cached && result === cached) })
      return result
    },
  }
  const runtime = createMemoryRuntime({
    store,
    resources,
    compute: async () => '',
    route: () => null,
    dailyNotes: true,
    canCommit: () => true,
    changed: () => {},
  })
  defer(() => runtime.close())

  // No profile.md registered -> zero disk reads.
  assert.equal(runtime.residentProfileText(), '')
  assert.equal(commitCalls.length, 0, 'absent resident profile must not touch disk')

  // Seed a resident profile directly in userWorkspace.
  const userWs = userWorkspaceId(memoryHash)
  const srcId = randomUUID()
  store.insertSource({
    id: srcId, operation: srcId, version: 1, conversation: 'c1', session: 's1',
    scope: { kind: 'user' }, context: { kind: 'user' }, project: null, author: 'user',
    text: '偏好简洁结论', hash: memoryHash('偏好简洁结论'), length: 6,
    question: null, requestId: null, questionId: null, at: Date.now(), timezone: 'UTC', outcome: 'received',
  })
  const src = store.readSource(srcId)!
  const docs = openMemoryDocuments({
    db: store.db,
    root: store.fileRoot,
    source: id => {
      const cur = store.readSource(id)
      return cur?.text ? { text: cur.text, workspace: memorySourceWorkspace(cur), token: memorySourceToken(cur) } : undefined
    },
  })
  const created = docs.commit({
    operationId: randomUUID(),
    workspace: userWs,
    path: RESIDENT_PROFILE_PATH,
    expectedRevision: null,
    action: 'CREATE',
    markdown: '---\nname: Personal Profile\ndescription: Resident\n---\n\n## 自动整理\n- 偏好简洁结论\n',
    sources: [{ id: srcId, token: memorySourceToken(src) }],
    reads: [],
  })

  // First read populates cache; subsequent reads reuse stat-validated cached snapshot.
  assert.match(runtime.residentProfileText(), /偏好简洁结论/)
  assert.equal(commitCalls.length, 1)
  assert.equal(commitCalls[0]!.hadCached, false)

  commitCalls.length = 0
  assert.match(runtime.residentProfileText(), /偏好简洁结论/)
  assert.match(runtime.residentProfileText(), /偏好简洁结论/)
  assert.equal(commitCalls.length, 2)
  assert.equal(commitCalls.every(call => call.hadCached && call.reused), true, 'unchanged profile must hit stat-cached fast path')

  // External disk edit invalidates cache immediately.
  const profileAbs = path.join(store.fileRoot, userWs, RESIDENT_PROFILE_PATH)
  const originalProfileBytes = fs.readFileSync(profileAbs, 'utf8')
  fs.writeFileSync(profileAbs, '---\nname: Personal Profile\ndescription: Resident\n---\n\n## 自动整理\n- 外部篡改\n')
  assert.equal(runtime.residentProfileText(), '', 'external on-disk mismatch must invalidate cached profile text')

  // Restoring original bytes and committing a new revision updates the cache cleanly.
  fs.writeFileSync(profileAbs, originalProfileBytes)
  docs.commit({
    operationId: randomUUID(),
    workspace: userWs,
    path: RESIDENT_PROFILE_PATH,
    expectedRevision: created.revision,
    action: 'REFINE',
    markdown: '---\nname: Personal Profile\ndescription: Resident\n---\n\n## 自动整理\n- 更新后的偏好\n',
    sources: [{ id: srcId, token: memorySourceToken(src) }],
    reads: [],
  })
  assert.match(runtime.residentProfileText(), /更新后的偏好/)
  commitCalls.length = 0
  assert.match(runtime.residentProfileText(), /更新后的偏好/)
  assert.equal(commitCalls.length, 1)
  assert.equal(commitCalls[0]!.hadCached && commitCalls[0]!.reused, true)
})

test('owner-worker deduplicates memory_owner_profile across unrelated memory changes while pushing real profile updates', async t => {
  const { dir, defer } = scratch(t, 'mem-perf-worker-dedup-')
  const root = path.join(dir, 'owner')
  const profileEvents: MemoryOwnerProfile[] = []
  let changeEvents = 0
  let channel!: ReturnType<typeof createRemoteMemoryChannel>
  const supervisor = createMemoryOwnerSupervisor({
    root,
    dailyNotes: true,
    callbacks: { compute: async () => '' },
    onEvent: event => {
      if (event.type === 'memory_owner_state') {
        channel.receive(event)
      } else if (event.type === 'memory_owner_change') {
        changeEvents++
      } else if (event.type === 'memory_owner_profile') {
        profileEvents.push(event)
      }
    },
  })
  channel = createRemoteMemoryChannel({
    callOwner: (method, input, options) => supervisor.callHost(method, input, options),
  })
  defer(async () => { channel.close(); await supervisor.close() })
  await supervisor.start()
  await channel.waitReady()

  const waitUntil = async (predicate: () => boolean, timeoutMs = 3_000) => {
    const deadline = Date.now() + timeoutMs
    while (!predicate() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 15))
    }
  }
  await waitUntil(() => profileEvents.length >= 1)
  assert.equal(profileEvents.length, 1, 'boot publishes exactly one initial profile snapshot')
  assert.equal(profileEvents[0]!.text, '')

  const client = createVivaMemoryClient(channel.call, channel.readBatch)

  // Perform multiple unrelated file mutations (create, edit, disable, enable): revision advances each time,
  // but profile text & profileDeletionGen are unchanged -> ZERO extra memory_owner_profile broadcasts!
  const created1 = await client.createFile({ operationId: randomUUID(), title: 'Note A', text: 'Unrelated wiki note alpha.\n' })
  const detail1 = (await client.readFile(created1.identity))!
  await client.editFile({ operationId: randomUUID(), identity: created1.identity, version: detail1.version, title: 'Note A', text: 'Unrelated wiki note alpha v2.\n' })
  const detail2 = (await client.readFile(created1.identity))!
  await client.setFileEnabled({ operationId: randomUUID(), identity: created1.identity, version: detail2.version, enabled: false })
  await waitUntil(() => changeEvents >= 3)
  // Allow any trailing worker notifications to flush.
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(profileEvents.length, 1, 'unrelated memory changes must NOT re-broadcast memory_owner_profile')

  // Now create a real resident profile and verify worker broadcasts the updated text with monotonic revision.
  const store = openMemoryStore(path.join(root, 'memory.db'))
  defer(() => store.close())
  const srcId = randomUUID()
  store.insertSource({
    id: srcId, operation: srcId, version: 1, conversation: 'c1', session: 's1',
    scope: { kind: 'user' }, context: { kind: 'user' }, project: null, author: 'user',
    text: '习惯晚上写代码', hash: memoryHash('习惯晚上写代码'), length: 7,
    question: null, requestId: null, questionId: null, at: Date.now(), timezone: 'UTC', outcome: 'received',
  })
  const src = store.readSource(srcId)!
  const userWs = userWorkspaceId(memoryHash)
  const docs = openMemoryDocuments({
    db: store.db,
    root: store.fileRoot,
    source: id => {
      const cur = store.readSource(id)
      return cur?.text ? { text: cur.text, workspace: memorySourceWorkspace(cur), token: memorySourceToken(cur) } : undefined
    },
  })
  const prof = docs.commit({
    operationId: randomUUID(),
    workspace: userWs,
    path: RESIDENT_PROFILE_PATH,
    expectedRevision: null,
    action: 'CREATE',
    markdown: '---\nname: Personal Profile\ndescription: Resident\n---\n\n## 自动整理\n- 习惯晚上写代码\n',
    sources: [{ id: srcId, token: memorySourceToken(src) }],
    reads: [],
  })
  const profileIdentity = { kind: 'digest' as const, workspace: userWs, id: prof.documentId }
  // Trigger a managed edit on the resident profile via IPC so worker observes & publishes the new profile text.
  const profDetail = (await client.readFile(profileIdentity))!
  await client.editFile({
    operationId: randomUUID(),
    identity: profileIdentity,
    version: profDetail.version,
    title: 'Personal Profile',
    text: '## 用户确认\n- 始终使用中文回复\n\n## 自动整理\n- 习惯晚上写代码\n',
  })
  await waitUntil(() => profileEvents.length >= 2)
  assert.equal(profileEvents.length, 2)
  assert.match(profileEvents[1]!.text, /始终使用中文回复/)
  assert.ok(profileEvents[1]!.revision > profileEvents[0]!.revision)

  // Another unrelated file creation must still emit zero extra profile broadcasts.
  const changesBefore = changeEvents
  await client.createFile({ operationId: randomUUID(), title: 'Note B', text: 'Another unrelated note.\n' })
  await waitUntil(() => changeEvents > changesBefore)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(profileEvents.length, 2, 'unrelated change after profile exists must still be deduplicated')

  // Deleting the resident profile must broadcast empty text + incremented profileDeletionGen + higher revision.
  const latestProf = (await client.readFile(profileIdentity))!
  await client.forgetFile({ operationId: randomUUID(), identity: profileIdentity, version: latestProf.version })
  await waitUntil(() => profileEvents.length >= 3)
  assert.equal(profileEvents.length, 3)
  assert.equal(profileEvents[2]!.text, '')
  assert.ok(profileEvents[2]!.revision > profileEvents[1]!.revision)
  assert.ok((profileEvents[2]!.profileDeletionGen ?? 0) >= 1)
})

test('Dream commit and multi-target checkpoint reuse stat-cached snapshots and deduplicate shared observed checks', async t => {
  const { dir, defer } = scratch(t, 'mem-perf-dream-tx-')
  const store = openMemoryStore(path.join(dir, 'memory.db'))
  defer(() => store.close())
  const effects = createEffects({ db: store.db, now: () => TODAY_MS })
  defer(() => effects.close())
  const TODAY_MS = Date.parse('2026-11-16T12:00:00.000Z')
  const readable = (id: string) => {
    const s = store.readSource(id)
    return Boolean(s?.text && s.outcome !== 'rejected')
  }
  const documents = openMemoryDocuments({
    db: store.db,
    root: store.fileRoot,
    now: () => TODAY_MS,
    source: id => {
      const s = store.readSource(id)
      return s?.text && readable(id) ? { text: s.text, workspace: memorySourceWorkspace(s), token: memorySourceToken(s) } : undefined
    },
  })
  const notes = openMemoryNotes(store, readable)
  const readPhysicalFile = createMemoryPhysicalFileReader(() => store.fileRoot)
  defer(() => readPhysicalFile.close())

  const commitReadLog: Array<{ path: string, hadCached: boolean, reused: boolean }> = []
  const jobs = createMemoryDreamJobs({
    store,
    notes,
    documents,
    effects,
    identity: { newId: randomUUID, hash: memoryHash },
    now: () => TODAY_MS,
    settings: { timezone: 'UTC', dreamTime: '03:00', scanDays: 7, dreamUnits: 10, dreamBatchBytes: 64_000 },
    readable,
    eligible: () => true,
    source: id => store.readSource(id) ?? undefined,
    reference: id => {
      const s = store.readSource(id)
      return s && readable(id) ? { namespace: 'canonical', sourceId: id, revision: s.version } : null
    },
    readPhysicalFile,
    readFileAtCommit(workspace, filePath, cached) {
      const res = readMemoryFileAtCommit(store.fileRoot, workspace, filePath, cached)
      commitReadLog.push({ path: filePath, hadCached: Boolean(cached), reused: Boolean(cached && res === cached) })
      return res
    },
    transaction: store.tx,
    calculate: async request => {
      if (request.system === DREAM_PROFILE_SYSTEM) return JSON.stringify({ action: 'NOOP' })
      // Read shared existing digest once; output NOOP so all 3 notes checkpoint together with shared observedReads.
      const res = await request.tools!.executeTool({ callId: 'c-shared', name: 'read', input: { path: 'digest/wiki/shared-infra.md' } })
      assert.equal(res.state, 'completed')
      return JSON.stringify({ operations: [] })
    },
  })

  const addNote = (text: string, session: string, day: string) => {
    const id = randomUUID()
    store.insertSource({
      id, operation: id, version: 1, conversation: session, session,
      scope: { kind: 'user' }, context: { kind: 'user' }, project: null, author: 'user',
      text, hash: memoryHash(text), length: text.length,
      question: null, requestId: null, questionId: null, at: TODAY_MS, timezone: 'UTC', outcome: 'received',
    })
    const src = store.readSource(id)!
    const key = notes.add(session, day, [src], '')!
    const rows = notes.pending(key)
    const refs = notes.snapshot([id])
    const ok = notes.commit(key, rows, { status: 'write', title: session, markdown: `- ${text}` }, 1, TODAY_MS, refs, undefined)
    assert.equal(ok, true)
    const saved = notes.read(key)!
    return { workspace: saved.workspace, key, path: saved.path, note: saved, src }
  }

  const seed = addNote('共享基础设施参考', 's-seed', '2026-11-15')
  documents.commit({
    operationId: randomUUID(),
    workspace: seed.workspace,
    path: 'digest/wiki/shared-infra.md',
    expectedRevision: null,
    action: 'CREATE',
    markdown: '---\nname: Shared Infra\ndescription: Infra doc\n---\n\n共享基础设施配置。\n',
    sources: [{ id: seed.src.id, token: memorySourceToken(seed.src) }],
    reads: [],
  })
  notes.markProcessed(seed.key, seed.note.revision)

  // Three separate daily notes in the same Dream batch sharing the same observed digest.
  addNote('每日记录一', 's-n1', '2026-11-16')
  addNote('每日记录二', 's-n2', '2026-11-16')
  addNote('每日记录三', 's-n3', '2026-11-16')

  jobs.run()
  await effects.wake()

  assert.equal(notes.changedFiles('2026-11-15', '2026-11-16').length, 0, 'all 3 daily notes must checkpoint cleanly')
  const sharedChecks = commitReadLog.filter(entry => entry.path === 'digest/wiki/shared-infra.md')
  assert.equal(sharedChecks.length, 1, 'shared observed digest must be live-checked only ONCE across all 3 targets in one transaction')
  assert.equal(sharedChecks[0]!.hadCached, true)
  assert.equal(sharedChecks[0]!.reused, true, 'live check must reuse stat-cached snapshot without re-reading disk')

  const dailyChecks = commitReadLog.filter(entry => entry.path.startsWith('daily/2026-11-16/'))
  assert.equal(dailyChecks.length, 3, 'each target daily note is checked once')
  assert.equal(dailyChecks.every(entry => entry.hadCached && entry.reused), true, 'every target daily note check must hit stat-cached fast path')

  // Also verify CREATE commit path reuses stat-cached snapshots inside assertMutateCurrent.
  commitReadLog.length = 0
  const n4 = addNote('新增数据库迁移约定', 's-n4', '2026-11-16')
  const jobsCommit = createMemoryDreamJobs({
    store,
    notes,
    documents,
    effects,
    identity: { newId: randomUUID, hash: memoryHash },
    now: () => TODAY_MS,
    settings: { timezone: 'UTC', dreamTime: '03:00', scanDays: 7, dreamUnits: 10, dreamBatchBytes: 64_000 },
    readable,
    eligible: () => true,
    source: id => store.readSource(id) ?? undefined,
    reference: id => {
      const s = store.readSource(id)
      return s && readable(id) ? { namespace: 'canonical', sourceId: id, revision: s.version } : null
    },
    readPhysicalFile,
    readFileAtCommit(workspace, filePath, cached) {
      const res = readMemoryFileAtCommit(store.fileRoot, workspace, filePath, cached)
      commitReadLog.push({ path: filePath, hadCached: Boolean(cached), reused: Boolean(cached && res === cached) })
      return res
    },
    transaction: store.tx,
    calculate: async request => {
      if (request.system === DREAM_PROFILE_SYSTEM) return JSON.stringify({ action: 'NOOP' })
      await request.tools!.executeTool({ callId: 'c-search', name: 'node_search', input: { query: '数据库' } })
      await request.tools!.executeTool({ callId: 'c-read', name: 'read', input: { path: 'digest/wiki/shared-infra.md' } })
      return JSON.stringify({
        operations: [{
          action: 'CREATE',
          path: 'digest/wiki/db-migration.md',
          name: 'DB Migration',
          description: 'Database migration conventions',
          body: '新增数据库迁移约定。\n',
          dailyPaths: [n4.path],
          sourceIds: [n4.src.id],
        }],
      })
    },
  })
  jobsCommit.run()
  await effects.wake()
  assert.ok(documents.read(n4.workspace, 'digest/wiki/db-migration.md'), 'CREATE digest must commit cleanly')
  const existingFileChecks = commitReadLog.filter(entry => entry.path !== 'digest/wiki/db-migration.md')
  assert.ok(existingFileChecks.length > 0)
  assert.equal(existingFileChecks.every(entry => entry.hadCached && entry.reused), true, 'assertMutateCurrent and checkpoint live checks must hit stat-cached fast path for every existing file')
})
