/** Real-model processing of frozen synthetic conversations through the production owner and DSH model loop.
 * Run by hand; never part of npm test. No fake endpoint, user history, or answer-generation score is used. */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, PUBLIC_BASE_URL, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { completeMemoryModel } from '../plugins/memory/lib/model.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { memoryProjectScope } from '../src/memory/node/project-scope.ts'
import { DEEPSEEK_DEFAULT } from '../src/backend/model-providers.ts'
import type { MemoryCompute } from '../src/memory/contracts/memory-contract.ts'
import type { MemoryFileDetail } from '../src/memory/contracts/file-management.ts'
import { DREAM_EXTRACT_SYSTEM, DREAM_INTEGRATE_SYSTEM, DREAM_VERIFY_SYSTEM, DREAM_TAG_SYSTEM } from '../src/memory/core/memory-dream-prompts.ts'
import { fileSnapshot, readLiveMemoryKey } from './live-memory.ts'
import { memoryOwnerCaller } from '../test/fixtures/memory-owner-caller.ts'
import { memorySemanticCases } from './memory-semantic-cases.ts'
import type { MemorySemanticCase } from './memory-semantic-cases.ts'
import { checkMemorySemanticFreeze } from './memory-semantic-freeze.ts'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
type JobRecord = { id: string, stage: string, system: string, input: string, startedAt: string,
  output?: string, error?: string, finishedAt?: string }
type RequestOrigin = { caseId: string, phaseId: string, jobId: string }
type PhaseResult = { id: string, sourceIds: string[], files: MemoryFileDetail[], documents: unknown[], pending: unknown[],
  recall: string, foreignProjectReads?: string[], userOnlyReads?: string[], jobs: JobRecord[], error?: string }
type CaseResult = { id: string, phases: PhaseResult[], error?: string }

function processingStage(job: MemoryCompute) {
  if (job.stage === 'note') return 'note'
  return new Map([[DREAM_EXTRACT_SYSTEM, 'extract'], [DREAM_INTEGRATE_SYSTEM, 'integrate'],
    [DREAM_VERIFY_SYSTEM, 'verify'], [DREAM_TAG_SYSTEM, 'tag']]).get(job.system) ?? job.stage
}

function gitFixture(directory: string) {
  mkdirSync(path.join(directory, '.git', 'objects'), { recursive: true })
  writeFileSync(path.join(directory, '.git', 'HEAD'), 'ref: refs/heads/semantic-evaluation\n')
}

/** Report only synthetic content. Credential material and arbitrary process environment are never serialized. */
export async function evaluateMemorySemantics(output: string, selected?: string) {
  const key = readLiveMemoryKey()
  const cases = selected ? memorySemanticCases.filter(item => item.id === selected) : memorySemanticCases
  assert.ok(cases.length, `Unknown case: ${selected}`)
  assert.ok(!['cases.json', 'report.json', 'state', 'model-attempts.jsonl'].some(file => existsSync(path.join(output, file))),
    'Evaluation output must be fresh; prior failures and raw responses must remain untouched')
  mkdirSync(output, { recursive: true })
  const fixtureHash = checkMemorySemanticFreeze()
  writeFileSync(path.join(output, 'cases.json'), `${JSON.stringify(memorySemanticCases, null, 2)}\n`)
  const origin = new AsyncLocalStorage<RequestOrigin>()
  const rawFile = path.join(output, 'model-attempts.jsonl')
  const record = (value: object) => {
    const serialized = JSON.stringify(value)
    assert.ok(!serialized.includes(key), 'Credential material must not reach evaluation artifacts')
    appendFileSync(rawFile, `${serialized}\n`)
  }
  const ctx = new Context(), llm = new LlmRuntime(ctx)
  const connection = resolveAdapterOptions({})
  assert.equal(connection.baseURL, PUBLIC_BASE_URL, 'Evaluation only permits the real official endpoint')
  const anonymous = getOrCreateAnonymousUserId({ env: { DSH_HOME: path.join(output, 'isolated-dsh-home') } })
  ctx.on('llm/stream', async function* (options, next) {
      const requestId = randomUUID(), source = origin.getStore()
      record({ kind: 'request', requestId, ...source, provider: options.provider, model: options.model,
        system: options.system, messages: options.messages, tools: options.tools, maxTokens: options.maxTokens })
      try {
        for await (const chunk of next()) {
          record({ kind: 'response', requestId, ...source, chunk })
          yield chunk
        }
      } catch (error) {
        record({ kind: 'request-error', requestId, ...source,
          error: error instanceof Error ? error.message.replaceAll(key, '[credential]') : 'Unknown provider error' })
        throw error
      } finally { record({ kind: 'request-end', requestId, ...source }) }
  })
  const registration = llm.registerAdapter([DEEPSEEK_DEFAULT.provider], new DeepSeekAdapter({
    options: () => connection, resolveAuth: async () => ({ headers: { 'x-api-key': key } }), resolveUserId: () => anonymous,
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  }))
  const report = { kind: 'real-model-memory-processing' as const, startedAt: new Date().toISOString(),
    fixtureHash, provider: DEEPSEEK_DEFAULT.provider, model: DEEPSEEK_DEFAULT.model, endpoint: PUBLIC_BASE_URL,
    frozenAssistantContext: true, finalSemanticReview: 'required' as const,
    limitations: ['Measures daily/dream evidence fidelity, not live foreground answers or retrieval-model accuracy.',
      'Pattern checks are review aids; attribution, negation, conditions and evidence require an independent semantic review.',
      'The seven fixed synthetic cases are regression examples, not an estimate of overall user accuracy.'],
    cases: [] as CaseResult[], finishedAt: '' }
  const save = () => writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  try {
    for (const fixture of cases) {
      const result: CaseResult = { id: fixture.id, phases: [] }
      report.cases.push(result)
      save()
      await runCase(fixture, result)
      save()
    }
  } finally {
    registration()
    report.finishedAt = new Date().toISOString()
    save()
  }
  return report

  async function runCase(fixture: MemorySemanticCase, result: CaseResult) {
    const directory = path.join(output, 'state', fixture.id)
    const workingDirectory = path.join(directory, 'project')
    mkdirSync(workingDirectory, { recursive: true })
    if (fixture.scope.kind === 'project') gitFixture(workingDirectory)
    const project = memoryProjectScope(workingDirectory)
    assert.equal(Boolean(project), fixture.scope.kind === 'project')
    const sessionId = randomUUID()
    let currentPhase: PhaseResult | undefined
    let computations = 0
    const owner = openMemoryOwner({ root: path.join(directory, 'memory'), dailyNotes: { noteInterval: 5, timezone: 'UTC' },
      route: () => ({ ...DEEPSEEK_DEFAULT }), quiesce: async () => {},
      async compute(job, signal, tools) {
        assert.ok(currentPhase, 'A model computation must belong to an explicit phase')
        if (++computations > 64) throw new Error('Evaluation exceeded its fixed per-case model-job budget')
        const entry: JobRecord = { id: job.id, stage: processingStage(job), system: job.system, input: job.input, startedAt: new Date().toISOString() }
        currentPhase.jobs.push(entry)
        save()
        process.stdout.write(`[semantic] ${fixture.id}/${currentPhase.id}: ${entry.stage}\n`)
        try {
          const auditedTools = tools ? { ...tools, executeTool: async (invocation: Parameters<typeof tools.executeTool>[0]) => {
            record({ kind: 'tool-call', ...origin.getStore(), invocation })
            try {
              const result = await tools.executeTool(invocation)
              record({ kind: 'tool-result', ...origin.getStore(), result })
              return result
            } catch (error) {
              record({ kind: 'tool-error', ...origin.getStore(), callId: invocation.callId,
                error: error instanceof Error ? error.message.replaceAll(key, '[credential]') : 'Unknown tool error' })
              throw error
            }
          } } : undefined
          entry.output = await origin.run({ caseId: fixture.id, phaseId: currentPhase.id, jobId: job.id },
            () => completeMemoryModel(ctx, job, AbortSignal.any([AbortSignal.timeout(180_000), ...(signal ? [signal] : [])]), auditedTools))
          return entry.output
        } catch (error) {
          entry.error = error instanceof Error ? error.message.replaceAll(key, '[credential]') : 'Unknown model failure'
          throw error
        } finally { entry.finishedAt = new Date().toISOString(); save() }
      },
    })
    let turn = 0
    const sourceIds = new Set<string>()
    try {
      await owner.recover()
      owner.initializeSession({ sessionId, cwd: workingDirectory })
      for (const phase of fixture.phases) {
        const snapshot: PhaseResult = { id: phase.id, sourceIds: [], files: [], documents: [], pending: [], recall: '', jobs: [] }
        currentPhase = snapshot
        result.phases.push(snapshot)
        save()
        try {
          for (const [index, pair] of phase.turns.entries()) {
            if (pair.answerTo) {
              const previous = phase.turns.slice(0, index).find(item => item.id === pair.answerTo!.turnId)
              assert.ok(previous?.assistant.includes(pair.answerTo.question), 'A short answer must follow its genuine frozen assistant question')
            }
            const at = Date.now()
            turn++
            const receipt = await owner.receiveSource({ sessionId, messageId: randomUUID(), text: pair.user, at, timezone: 'UTC',
              turn, step: 1, admitted: true, inherited: false })
            sourceIds.add(receipt.sourceId)
            snapshot.sourceIds.push(receipt.sourceId)
            await owner.completeTurn({ sessionId, turn, eventSeq: turn * 2 + 1, sourceIds: [receipt.sourceId], assistant: pair.assistant,
              completed: true, at, timezone: 'UTC' })
          }
          owner.runtime.flushNoteTurns?.(sessionId)
          await owner.runtime.wake()
          assert.ok(snapshot.jobs.some(job => job.stage === 'note'), 'The production daily processor must actually call the model')
          if (snapshot.jobs.some(job => job.error)) throw new Error('Daily model processing failed; see the preserved response')
          await owner.runtime.runDocumentDream()
          await owner.runtime.wake()
          snapshot.files = await fileSnapshot(memoryOwnerCaller(owner))
          for (const workspace of new Set(snapshot.files.map(file => file.identity.workspace))) {
            snapshot.documents.push(...owner.runtime.listDocuments?.(workspace) ?? [])
            snapshot.pending.push(...owner.runtime.pendingDocumentClarifications?.(workspace) ?? [])
          }
          for (const file of snapshot.files) assert.ok(file.sources.length > 0 && file.sources.every(source => sourceIds.has(source.sourceId)),
            'Every accepted file must retain only admitted synthetic user evidence')
          const reader = randomUUID()
          owner.initializeSession({ sessionId: reader, cwd: workingDirectory })
          snapshot.recall = owner.runtime.handle({ op: 'recall', session: reader, query: phase.recallQuery }, owner.sessionContext(reader))
          if (project) {
            const foreignDirectory = path.join(directory, 'independent-project')
            gitFixture(foreignDirectory)
            const foreign = randomUUID()
            owner.initializeSession({ sessionId: foreign, cwd: foreignDirectory })
            snapshot.foreignProjectReads = snapshot.files.map(file => owner.runtime.handle({ op: 'file_read', session: foreign, id: file.identity.id }, owner.sessionContext(foreign)))
            assert.ok(snapshot.foreignProjectReads.every(text => JSON.parse(text).status === 'unavailable'),
              'An independent project must not read an accepted project file')
            const userOnly = randomUUID()
            owner.initializeSession({ sessionId: userOnly })
            snapshot.userOnlyReads = snapshot.files.map(file => owner.runtime.handle({ op: 'file_read', session: userOnly, id: file.identity.id }, owner.sessionContext(userOnly)))
            assert.ok(snapshot.userOnlyReads.every(text => JSON.parse(text).status === 'unavailable'),
              'A personal origin must not read an accepted project file')
          }
          if (snapshot.jobs.some(job => job.error)) throw new Error('Dream model processing failed; see the preserved response')
          assert.ok(snapshot.jobs.some(job => job.stage === 'extract'), 'The production dream must actually extract from the daily result')
          assert.ok(snapshot.files.some(file => file.identity.kind === 'digest' && file.applicability === 'current'),
            'Required unambiguous facts must reach an accepted current digest; a model success claim is insufficient')
        } catch (error) {
          snapshot.error = error instanceof Error ? error.message : String(error)
          result.error = snapshot.error
          save()
          break
        }
        save()
      }
    } finally {
      await owner.close()
      const db = new DatabaseSync(path.join(directory, 'memory', 'memory.db'), { readOnly: true })
      try {
        writeFileSync(path.join(directory, 'canonical-sources.json'), `${JSON.stringify(db.prepare('SELECT id,text,author,question,version,context,project FROM memory_sources ORDER BY rowid').all(), null, 2)}\n`)
      } finally { db.close() }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const selected = process.argv.find(argument => argument.startsWith('--case='))?.slice('--case='.length)
  const output = process.argv.find(argument => argument.startsWith('--output='))?.slice('--output='.length)
    ?? path.join(ROOT, 'smoke', `memory-semantic-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}`)
  evaluateMemorySemantics(path.resolve(output), selected).then(report => {
    process.stdout.write(`[semantic] ${report.cases.length} case(s) recorded; independent semantic review required. ${output}\n`)
    if (report.cases.some(item => item.error)) process.exitCode = 1
  }).catch(error => { process.stderr.write(`memory-semantic: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
}
