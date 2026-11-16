import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { digitsOf, hasHan, latinShare } from './smoke/live-kit.ts'
import { LIVE_SCENARIOS, repeatOf, selectScenarios } from './smoke/live.ts'
import { RAW_ERROR } from './smoke/live-scenarios-app.ts'
import { summarize } from '../scripts/live-report.mjs'

const FEATURES = fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', 'features.zh-CN.md'), 'utf8')

test('there are 29 scenarios, each named once, each covering a section of features.md', () => {
  const ids = LIVE_SCENARIOS.map((scenario) => scenario.id)
  assert.equal(ids.length, 29)
  assert.equal(new Set(ids).size, ids.length)
  for (const scenario of LIVE_SCENARIOS) {
    assert.ok(scenario.title && typeof scenario.run === 'function', scenario.id)
    assert.match(FEATURES, new RegExp(`^#{2,3} ${scenario.feature}$`, 'm'), `${scenario.id}: no section「${scenario.feature}」in docs/features.md`)
  }
})

test('the scenarios picked: all, the core ones, or those named', () => {
  assert.equal(selectScenarios({}).length, 29)
  const core = selectScenarios({ LIVE_SET: 'core' })
  assert.ok(core.length >= 10 && core.every((scenario) => scenario.core))
  assert.ok(core.some((scenario) => scenario.id === 'history'), 'the core set takes the app started again')
  assert.deepEqual(selectScenarios({ LIVE_ONLY: 'steer, desk' }).map((scenario) => scenario.id), ['steer', 'desk'])
  assert.throws(() => selectScenarios({ LIVE_ONLY: 'nope' }), /no such scenario: nope/)
  assert.throws(() => selectScenarios({ LIVE_SET: 'some' }), /core or full/)
})

test('each scenario runs three times unless told otherwise, and never an absurd number of times', () => {
  assert.equal(repeatOf({}), 3)
  assert.equal(repeatOf({ LIVE_REPEAT: '1' }), 1)
  for (const bad of ['0', '11', '2.5', 'x']) assert.throws(() => repeatOf({ LIVE_REPEAT: bad }), /whole number/)
})

test('what the checks read in an answer: digits with separators, English, Chinese', () => {
  assert.equal(digitsOf('合计 8,024.00 元，即 8 024'), '合计 8024.00 元，即 8024')
  assert.ok(latinShare('Coffee culture in the city 咖啡') > 0.6)
  assert.ok(latinShare('城市里的咖啡文化 coffee') < 0.6)
  assert.equal(latinShare(''), 0)
  assert.deepEqual([hasHan('密钥不对'), hasHan('401 Unauthorized')], [true, false])
})

test('a raw error is told from a plain Chinese one', () => {
  // As the window showed it for a wrong key, in the dry run of the live check.
  assert.match('出错了Internal error: turn failed: 401: {"message":"Authentication Fails, Your api key: ****-key is invalid"}', RAW_ERROR)
  assert.match('连接失败：connect ECONNREFUSED 127.0.0.1:9', RAW_ERROR)
  assert.doesNotMatch('API key 不对，去设置里检查一下。', RAW_ERROR)
  assert.doesNotMatch('连不上模型服务，检查网络后再试。', RAW_ERROR)
})

const attempt = (ok: boolean, ms: number, failures: string[] = []) => ({ ok, ms, failures, shots: [] })
type Scenario = { id: string, title: string, feature: string, core: boolean, step: string, attempts: ReturnType<typeof attempt>[] }
const phase = (name: string, scenarios: Scenario[]) => ({ phase: name, set: 'full', repeat: 2, startedAt: '2026-10-26T02:00:00.000Z', endedAt: '2026-10-26T02:40:00.000Z', scenarios })

test('the report puts both launches together, failures first, and compares with the last run', () => {
  const live = phase('live', [
    { id: 'steer', title: '插话', feature: '工作中插话', core: true, step: 'run', attempts: [attempt(true, 30_000), attempt(false, 40_000, ['the final answer should be in English'])] },
    { id: 'chat', title: '表格', feature: '消息里的 Markdown', core: false, step: 'run', attempts: [attempt(true, 10_000), attempt(true, 12_000)] },
    { id: 'history', title: '重开', feature: '历史对话', core: true, step: 'prepare', attempts: [attempt(true, 5_000), attempt(true, 5_000)] },
  ])
  const resume = phase('live-resume', [
    { id: 'history', title: '重开', feature: '历史对话', core: true, step: 'run', attempts: [attempt(true, 8_000), attempt(true, 9_000)] },
  ])
  const baseline = { scenarios: [{ id: 'steer', passed: 2, attempts: 2, ms: 20_000 }, { id: 'chat', passed: 2, attempts: 2, ms: 30_000 }] }
  const { markdown, json } = summarize([live, resume], baseline)
  assert.deepEqual(json.totals, { scenarios: 3, passed: 2, failed: 1 })
  assert.deepEqual(json.scenarios.map((s) => [s.id, s.passed, s.attempts]), [['steer', 1, 2], ['chat', 2, 2], ['history', 4, 4]])
  assert.ok(markdown.indexOf('❌ steer') < markdown.indexOf('✅ chat'), 'what failed comes first')
  assert.match(markdown, /1\/2/)
  assert.match(markdown, /the final answer should be in English/)
  assert.match(markdown, /上次 2\/2/, 'a scenario worse than last time says so')
  assert.match(markdown, /通过 2 \/ 3/)
})

/** Live helpers execute their actual page-side API calls without starting a paid model. */
function memoryWindow(api: object): import('./smoke/smoke-kit.ts').SmokeWindow {
  return { webContents: { executeJavaScript: async (code: string) => {
    const { runInNewContext } = await import('node:vm')
    return runInNewContext(code, { window: { agent: api } }) as unknown
  } } } as import('./smoke/smoke-kit.ts').SmokeWindow
}

test('live file discovery reads full paginated bodies and ignores stopped or superseded historical evidence', async () => {
  const { memoryFilesWith } = await import('./smoke/live-kit.ts')
  const detail = (id: string, active = true, applicability: 'current' | 'superseded' = 'current'): import('../src/shared/ipc-results.ts').MemoryFileDetailView => ({
    identity: { kind: 'digest', workspace: 'workspace', id }, title: 'A title without the search token', path: `digest/wiki/${id}.md`,
    version: { contentRevision: id, usageVersion: 1, policyToken: id }, enabled: active, applicability,
    actions: { setEnabled: true, edit: false, forget: false, undo: null }, markdown: 'Only the body has NEEDLE.', sources: [],
  })
  const items = [detail('disabled', false), detail('old', true, 'superseded'), detail('current')]
  const queries: object[] = []
  const win = memoryWindow({
    async listMemoryFiles(request: { cursor?: { offset: number } }) {
      queries.push(request)
      const offset = request.cursor?.offset ?? 0
      const { markdown: _markdown, sources: _sources, ...summary } = items[offset]!
      return { status: 'ok', snapshot: 'snapshot', items: [summary], nextCursor: offset < 2 ? { snapshot: 'snapshot', offset: offset + 1 } : null }
    },
    async readMemoryFile(identity: { id: string }) { return items.find(item => item.identity.id === identity.id) ?? null },
  })
  assert.deepEqual((await memoryFilesWith(win, 'NEEDLE')).map(item => item.identity.id), ['current'])
  assert.equal(queries.length, 3, 'later pages cannot disappear behind a title query')
  assert.ok(queries.every(query => !('query' in query)))
  assert.deepEqual((await memoryFilesWith(win, 'NEEDLE', true)).map(item => item.identity.id), ['disabled', 'old', 'current'])
})

test('live file cleanup replays an unconfirmed operation and never labels a pending replica as fully erased', async t => {
  const { randomUUID } = await import('node:crypto')
  const { scratch } = await import('./fixtures/scratch.js')
  const { openMemoryOwner } = await import('../src/memory/node/owner.ts')
  const { memoryFileMutationResult } = await import('../src/memory/contracts/file-management.ts')
  const { memoryOperationOutcome } = await import('../src/memory/contracts/service.ts')
  const { forgetMemories, memoryFilesWith } = await import('./smoke/live-kit.ts')
  const { dir, defer } = scratch(t, 'viva-live-file-cleanup-')
  const owner = openMemoryOwner({ root: dir, fileMode: true, hostNamespace: 'live-fixture',
    compute: () => null, route: () => null, quiesce: async () => {} })
  defer(() => owner.close())
  await owner.recover()
  const created = memoryFileMutationResult.parse(await owner.handleHost('createFile', {
    args: [{ operationId: randomUUID(), title: 'General note', text: 'A live cleanup NEEDLE.' }] }))
  const requests: import('../src/memory/contracts/file-management.ts').MemoryFileForgetRequest[] = []
  const win = memoryWindow({
    listMemoryFiles: (request: import('../src/memory/contracts/file-management.ts').MemoryFileListRequest) => owner.handleHost('listFiles', { args: [request] }),
    readMemoryFile: (identity: import('../src/memory/contracts/file-management.ts').MemoryManagedFileIdentity, restriction?: string) =>
      owner.handleHost('readFile', { args: [identity, restriction] }),
    async forgetMemoryFile(request: import('../src/memory/contracts/file-management.ts').MemoryFileForgetRequest) {
      requests.push(request)
      const receipt = await owner.handleHost('forgetFile', { args: [request] })
      if (requests.length === 1) throw new Error('Owner committed; the response was lost')
      return { status: 'applied', receipt, cleanup: 'pending' }
    },
  })
  assert.equal((await memoryFilesWith(win, 'NEEDLE')).length, 1)
  await forgetMemories(win, 'NEEDLE')
  assert.equal(requests.length, 2)
  assert.equal(JSON.stringify(requests[0]), JSON.stringify(requests[1]))
  assert.equal((await memoryFilesWith(win, 'NEEDLE', true)).length, 0)
  assert.equal(owner.runtime.readFile(created.identity), null)
  const outcome = memoryOperationOutcome.parse(await owner.handleHost('getOperation', { operationId: requests[0]!.operationId }))
  assert.equal(outcome?.cleanup, 'pending', 'logical withdrawal is separate from physical replica completion')
})

test('the offline runtime benchmark uses source-backed files, file profile and project-scoped retrieval', async () => {
  const { checkRuntime } = await import('../scripts/memory-embedding-check.ts')
  const result = await checkRuntime({ fingerprint: 'unit-test-wiring-only', dimensions: 8,
    embedBatch: async inputs => inputs.map(() => Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0])), close() {} })
  assert.equal(result.engine, 'source-backed-files')
  assert.equal(result.retrieval.automatic, 'file-hybrid-context')
  const absent = result.cases.find(item => item.text === 'What is the capital of Sweden?')!
  assert.equal(absent.keyword.hits.length, 0)
  assert.ok(absent.automatic.hits.length > 0, 'the offline unit vectors reach the async hybrid injection path, not lexical-only context')
  assert.equal(result.cases.length > 0, true)
  assert.deepEqual(result.scopeCases.map(item => item.expected), [[], ['allowed-escrow'], ['private-escrow']])
})

test('live file discovery restarts from the beginning when a body version changed during pagination', async () => {
  const { memoryFilesWith } = await import('./smoke/live-kit.ts')
  const file = { identity: { kind: 'digest' as const, workspace: 'workspace', id: 'changing' }, title: 'Title', path: 'digest/wiki/changing.md',
    version: { contentRevision: 'new', usageVersion: 2, policyToken: 'new' }, enabled: true, applicability: 'current' as const,
    actions: { setEnabled: true, edit: false, forget: false, undo: null } }
  let lists = 0
  const win = memoryWindow({
    async listMemoryFiles() {
      lists++
      return { status: 'ok', snapshot: String(lists), items: [{ ...file,
        version: lists === 1 ? { contentRevision: 'old', usageVersion: 1, policyToken: 'old' } : file.version }], nextCursor: null }
    },
    async readMemoryFile() { return { ...file, markdown: 'Current NEEDLE body.', sources: [] } },
  })
  const found = await memoryFilesWith(win, 'NEEDLE')
  assert.equal(lists, 2)
  assert.equal(found.length, 1)
  assert.equal(found[0]!.version.contentRevision, 'new')
})

test('the real-model report collects authorized file bodies and source references through the owner API', async t => {
  const { fileSnapshot } = await import('../scripts/live-memory.ts')
  const { randomUUID } = await import('node:crypto')
  const { scratch } = await import('./fixtures/scratch.js')
  const { openMemoryOwner } = await import('../src/memory/node/owner.ts')
  const { memoryFileMutationResult } = await import('../src/memory/contracts/file-management.ts')
  const { dir, defer } = scratch(t, 'viva-live-file-report-')
  const owner = openMemoryOwner({ root: dir, fileMode: true, compute: () => null, route: () => null, quiesce: async () => {} })
  defer(() => owner.close())
  await owner.recover()
  const created = memoryFileMutationResult.parse(await owner.handleHost('createFile', {
    args: [{ operationId: randomUUID(), text: 'An authorized report sample.' }] }))
  const call: import('../src/memory/contracts/host.ts').HostMemoryCaller = (method, input) =>
    owner.handleHost(method, input) as ReturnType<import('../src/memory/contracts/host.ts').HostMemoryCaller>
  const files = await fileSnapshot(call)
  assert.equal(files.length, 1)
  assert.equal(files[0]!.identity.id, created.identity.id)
  assert.ok(files[0]!.markdown.includes('An authorized report sample.'))
  assert.equal(files[0]!.sources.length, 1)
})
