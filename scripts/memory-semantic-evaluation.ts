/** Real-model processing of frozen synthetic conversations through the production owner and DSH model loop.
 * Run by hand; never part of npm test. No fake endpoint, user history, or answer-generation score is used. */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
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
import { DREAM_CONSOLIDATE_SYSTEM } from '../src/memory/core/memory-dream-prompts.ts'
import { fileSnapshot, readLiveMemoryKey } from './live-memory.ts'
import { memoryOwnerCaller } from '../test/fixtures/memory-owner-caller.ts'
import { memorySemanticCases } from './memory-semantic-cases.ts'
import type { MemorySemanticCase } from './memory-semantic-cases.ts'
import { checkMemorySemanticFreeze } from './memory-semantic-freeze.ts'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
type JobRecord = { id: string, generation: number, stage: string, system: string, input: string, startedAt: string,
  output?: string, error?: string, finishedAt?: string }
type RequestOrigin = { caseId: string, phaseId: string, jobId: string, generation: number }
type PhaseResult = { id: string, sourceIds: string[], files: MemoryFileDetail[], documents: unknown[], pending: unknown[],
  recall: string, foreignProjectReads?: string[], userOnlyReads?: string[], jobs: JobRecord[], error?: string,
  recoveryBefore?: ReturnType<typeof durableState>, recoveryAfter?: ReturnType<typeof durableState>,
  explicitDueWakes?: Array<{ dueAt: number, at: number, generation: number, attempts: number }> }
type CaseResult = { id: string, phases: PhaseResult[], error?: string }

function processingStage(job: MemoryCompute) {
  if (job.stage === 'note') return 'note'
  return job.system === DREAM_CONSOLIDATE_SYSTEM ? 'consolidate' : job.stage
}

function gitFixture(directory: string) {
  mkdirSync(path.join(directory, '.git', 'objects'), { recursive: true })
  writeFileSync(path.join(directory, '.git', 'HEAD'), 'ref: refs/heads/semantic-evaluation\n')
}

export function memorySemanticTreeHash(directory: string): string {
  const digest = createHash('sha256')
  function visit(relative: string) {
    for (const name of readdirSync(path.join(directory, relative)).sort()) {
      const next = path.join(relative, name), file = path.join(directory, next), stat = lstatSync(file)
      assert.ok(!stat.isSymbolicLink(), 'Recovery snapshots cannot follow links')
      if (stat.isDirectory()) visit(next)
      else if (stat.isFile()) digest.update(JSON.stringify(next)).update(readFileSync(file))
    }
  }
  visit('')
  return digest.digest('hex')
}

/** Resolve an existing parent before considering a not-yet-created destination. */
export function validateMemorySemanticRecoveryOutput(output: string, original: string) {
  function canonical(file: string) {
    let existing = path.resolve(file)
    const suffix: string[] = []
    while (!existsSync(existing)) {
      suffix.unshift(path.basename(existing))
      const parent = path.dirname(existing)
      assert.notEqual(parent, existing, 'Recovery path has no existing parent')
      existing = parent
    }
    return path.join(realpathSync.native(existing), ...suffix)
  }
  const source = canonical(original), target = canonical(output)
  const inside = (parent: string, child: string) => {
    const relative = path.relative(parent, child)
    return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  }
  assert.ok(!inside(source, target) && !inside(target, source), 'Recovery output and the preserved original run cannot overlap')
}

function durableState(directory: string) {
  const db = new DatabaseSync(path.join(directory, 'memory', 'memory.db'), { readOnly: true })
  try {
    const row = db.prepare("SELECT generation,due_at,attempts,payload FROM effects WHERE kind='memory.dream' AND key='daily'").get()
    const payload = row ? JSON.parse(String(row.payload)) as { units?: Array<{ operationId: string, state: string, unit: { name: string } }> } | null : null
    return { generation: row?.generation, dueAt: Number(row?.due_at ?? 0), attempts: Number(row?.attempts ?? 0), units: payload?.units ?? [],
      sources: db.prepare('SELECT id,operation,text,hash,length,version,author,withdrawn,question,scope,context,project,session,conversation,at,timezone FROM memory_sources ORDER BY id').all(),
      notes: db.prepare('SELECT key,revision,processed FROM memory_daily_notes ORDER BY key').all(),
      receipts: db.prepare('SELECT operation,receipt FROM memory_document_receipts ORDER BY operation').all(),
      documents: db.prepare('SELECT id,path,forgotten FROM memory_documents ORDER BY id').all(),
      revisions: db.prepare('SELECT operation,COUNT(*) AS count FROM memory_document_revisions GROUP BY operation ORDER BY operation').all() }
  } finally { db.close() }
}

/** Report only synthetic content. Credential material and arbitrary process environment are never serialized. */
export async function evaluateMemorySemantics(output: string, selected?: string, recoveryFrom?: string) {
  const key = readLiveMemoryKey()
  const cases = selected ? memorySemanticCases.filter(item => item.id === selected) : memorySemanticCases
  assert.ok(cases.length, `Unknown case: ${selected}`)
  if (recoveryFrom) validateMemorySemanticRecoveryOutput(output, recoveryFrom)
  assert.ok(!['cases.json', 'report.json', 'state', 'model-attempts.jsonl'].some(file => existsSync(path.join(output, file))),
    'Evaluation output must be fresh; prior failures and raw responses must remain untouched')
  mkdirSync(output, { recursive: true })
  const fixtureHash = checkMemorySemanticFreeze()
  let original: { directory: string, stateHash: string, reportHash: string, rawHash: string } | undefined
  if (recoveryFrom) {
    assert.equal(cases.length, 1, 'Recover exactly one selected synthetic case')
    const prior = JSON.parse(readFileSync(path.join(recoveryFrom, 'report.json'), 'utf8')) as { fixtureHash: string, finishedAt: string, kind: string }
    assert.equal(prior.kind, 'real-model-memory-processing')
    assert.equal(prior.fixtureHash, fixtureHash)
    assert.ok(prior.finishedAt, 'The original evaluation must be finished and closed')
    const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
    const directory = path.join(recoveryFrom, 'state', cases[0]!.id)
    original = { directory, stateHash: memorySemanticTreeHash(directory), reportHash: hash(path.join(recoveryFrom, 'report.json')), rawHash: hash(path.join(recoveryFrom, 'model-attempts.jsonl')) }
  }
  writeFileSync(path.join(output, 'cases.json'), `${JSON.stringify(memorySemanticCases, null, 2)}\n`)
  const recoveryDeadline = recoveryFrom ? AbortSignal.timeout(600_000) : undefined
  let modelRequests = 0
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
      if (recoveryFrom && modelRequests >= 32) throw new Error('Recovery reached its 32-request budget')
      modelRequests++
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
  const report = { kind: recoveryFrom ? 'real-model-memory-recovery' : 'real-model-memory-processing', startedAt: new Date().toISOString(),
    implementation: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    fixtureHash, provider: DEEPSEEK_DEFAULT.provider, model: DEEPSEEK_DEFAULT.model, endpoint: PUBLIC_BASE_URL,
    frozenAssistantContext: true, finalSemanticReview: 'required' as const,
    limitations: ['Measures daily/dream evidence fidelity, not live foreground answers or retrieval-model accuracy.',
      'Pattern checks are review aids; attribution, negation, conditions and evidence require an independent semantic review.',
      'The seven fixed synthetic cases are regression examples, not an estimate of overall user accuracy.'],
    ...(original ? { recoveryFrom, original, recoveryBudget: { modelJobs: 12, modelRequests: 32, explicitDueWakes: 2, elapsedMs: 600_000 } } : {}),
    cases: [] as CaseResult[], modelRequests: 0, finishedAt: '' }
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
    report.modelRequests = modelRequests
    report.finishedAt = new Date().toISOString()
    save()
    if (original) {
      assert.equal(memorySemanticTreeHash(original.directory), original.stateHash, 'Recovery must not mutate the original synthetic state')
      assert.equal(createHash('sha256').update(readFileSync(path.join(recoveryFrom!, 'report.json'))).digest('hex'), original.reportHash)
      assert.equal(createHash('sha256').update(readFileSync(path.join(recoveryFrom!, 'model-attempts.jsonl'))).digest('hex'), original.rawHash)
    }
  }
  return report

  async function runCase(fixture: MemorySemanticCase, result: CaseResult) {
    const directory = path.join(output, 'state', fixture.id)
    if (original) cpSync(original.directory, directory, { recursive: true, errorOnExist: true, force: false })
    const workingDirectory = path.join(directory, 'project')
    mkdirSync(workingDirectory, { recursive: true })
    if (!original && fixture.scope.kind === 'project') gitFixture(workingDirectory)
    const project = memoryProjectScope(workingDirectory)
    assert.equal(Boolean(project), fixture.scope.kind === 'project')
    const sessionId = randomUUID()
    let currentPhase: PhaseResult | undefined = original ? { id: 'durable-recovery', sourceIds: [], files: [], documents: [], pending: [], recall: '', jobs: [],
      recoveryBefore: durableState(directory) } : undefined
    if (currentPhase) {
      const allowed = new Set(fixture.phases.flatMap(phase => phase.turns.map(turn => turn.user)))
      assert.ok(currentPhase.recoveryBefore!.sources.every(source => source.author === 'user' && source.question === null
        && source.version === 1 && !source.withdrawn && typeof source.text === 'string' && allowed.has(source.text)),
        'Only the exact frozen synthetic user sources may reach recovery model computation')
      assert.equal(currentPhase.recoveryBefore!.sources.length, allowed.size)
      result.phases.push(currentPhase)
    }
    let computations = 0
    const owner = openMemoryOwner({ root: path.join(directory, 'memory'), dailyNotes: { noteInterval: 5, timezone: 'UTC' },
      route: () => ({ ...DEEPSEEK_DEFAULT }), quiesce: async () => {},
      async compute(job, signal, tools) {
        assert.ok(currentPhase, 'A model computation must belong to an explicit phase')
        if (++computations > (recoveryFrom ? 12 : 64)) throw new Error('Evaluation exceeded its fixed per-case model-job budget')
        const entry: JobRecord = { id: job.id, generation: job.generation, stage: processingStage(job), system: job.system, input: job.input, startedAt: new Date().toISOString() }
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
          entry.output = await origin.run({ caseId: fixture.id, phaseId: currentPhase.id, jobId: job.id, generation: job.generation },
            () => completeMemoryModel(ctx, job, AbortSignal.any([AbortSignal.timeout(180_000), ...(signal ? [signal] : []), ...(recoveryDeadline ? [recoveryDeadline] : [])]), auditedTools))
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
      if (original && currentPhase) {
        currentPhase.explicitDueWakes = []
        const complete = (state: ReturnType<typeof durableState>) => state.units.every(unit => unit.state === 'done')
          && state.notes.every(note => note.revision === note.processed)
        for (let pass = 0; pass < 2; pass++) {
          recoveryDeadline!.throwIfAborted()
          let pending = durableState(directory)
          if (complete(pending)) break
          while (pending.dueAt > Date.now()) {
            await delay(Math.min(60_000, pending.dueAt - Date.now()), undefined, { signal: recoveryDeadline })
            pending = durableState(directory)
            if (complete(pending)) break
          }
          if (complete(pending)) break
          recoveryDeadline!.throwIfAborted()
          currentPhase.explicitDueWakes.push({ dueAt: pending.dueAt, at: Date.now(), generation: Number(pending.generation), attempts: pending.attempts })
          await owner.runtime.wake()
        }
        currentPhase.files = await fileSnapshot(memoryOwnerCaller(owner))
        currentPhase.recoveryAfter = durableState(directory)
        const before = currentPhase.recoveryBefore!, after = currentPhase.recoveryAfter
        assert.deepEqual(after.sources, before.sources, 'Retry must not create or mutate canonical user sources')
        for (const receipt of before.receipts) assert.equal(after.receipts.find(item => item.operation === receipt.operation)?.receipt, receipt.receipt,
          'A committed operation cannot be replayed as another revision')
        for (const document of before.documents.filter(row => !row.forgotten)) assert.ok(after.documents.some(row => row.id === document.id && !row.forgotten),
          'Cold retry must preserve already accepted document identities')
        assert.ok(after.revisions.every(row => row.count === 1), 'An operation creates at most one revision')
        if (after.units.some(unit => unit.state !== 'done') || after.notes.some(note => note.processed !== note.revision)) {
          currentPhase.error = result.error = 'Recovery remains pending after its bounded normal-due retries'
        } else {
          for (const unit of before.units.filter(unit => unit.state === 'pending')) assert.ok(after.receipts.some(row => row.operation === unit.operationId),
            'Completion must use each original pending operation ID')
        }
        save()
        return
      }
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
          assert.ok(snapshot.jobs.some(job => job.stage === 'consolidate'), 'The production dream must actually consolidate from the daily result')
          assert.ok(snapshot.files.some(file => file.identity.kind === 'digest' && file.enabled),
            'Required unambiguous facts must reach an accepted current digest; a model success claim is insufficient')
        } catch (error) {
          snapshot.error = error instanceof Error ? error.message : String(error)
          result.error = snapshot.error
          save()
          break
        }
        save()
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message.replaceAll(key, '[credential]') : 'Unknown case failure'
      if (currentPhase) currentPhase.error = result.error
      save()
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
  const recoveryFrom = process.argv.find(argument => argument.startsWith('--recover-from='))?.slice('--recover-from='.length)
  const output = process.argv.find(argument => argument.startsWith('--output='))?.slice('--output='.length)
    ?? path.join(ROOT, 'smoke', `memory-semantic-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}`)
  evaluateMemorySemantics(path.resolve(output), selected, recoveryFrom && path.resolve(recoveryFrom)).then(report => {
    process.stdout.write(`[semantic] ${report.cases.length} case(s) recorded; independent semantic review required. ${output}\n`)
    if (report.cases.some(item => item.error)) process.exitCode = 1
  }).catch(error => { process.stderr.write(`memory-semantic: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
}
