import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import type { MemoryCompute } from '../src/memory/contracts/memory-contract.ts'
import { createMemoryDreamJobs, batchDreamNotes } from '../src/memory/core/memory-dream-jobs.ts'
import type { DreamCalculate } from '../src/memory/core/memory-dream-jobs.ts'
import { validateDreamReview } from '../src/memory/core/memory-dream-evidence.ts'
import { inspectMemoryDocumentText } from '../src/memory/core/memory-dream-material.ts'
import { formatMemoryDocument, updateMemoryFrontmatter } from '../src/memory/core/memory-document.ts'
import { looksSecret } from '../src/memory/core/memory-sensitive.ts'
import { createEffects } from '../src/memory/node/effects.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { openMemoryStore, memoryHash } from '../src/memory/node/memory-store.ts'
import type { DocumentReceipt } from '../src/memory/core/ports/documents.ts'
import type { MemorySource } from '../src/memory/core/ports/store.ts'
import { noteSource } from './fixtures/memory-note-fixture.ts'
import { dreamModelStep } from './fixtures/dream-model.ts'

function harness(t: TestContext, options: { units?: number, budget?: number } = {}) {
  let now = Date.parse('2026-11-16T12:00:00Z')
  const store = openMemoryStore(':memory:', () => now)
  const readable = (id: string) => Boolean(store.readSource(id)?.text && !store.readSource(id)?.withdrawn)
  const notes = openMemoryNotes(store, readable)
  const documents = openMemoryDocuments({ db: store.db, root: store.fileRoot, now: () => now,
    source(id) {
      const original = store.readSource(id)
      return original?.text && readable(id) ? { token: memorySourceToken(original), workspace: memorySourceWorkspace(original), text: original.text } : undefined
    },
  })
  let effects = createEffects({ db: store.db, now: () => now, later: () => null, cancel: () => {} })
  const requests: Parameters<DreamCalculate>[0][] = []
  let fixtureOptions: Parameters<typeof dreamModelStep>[2] = {}
  const defaultModel: DreamCalculate = async request => {
    const job: MemoryCompute = { id: randomUUID(), sourceId: request.sourceIds()[0]!, stage: 'dream', generation: request.job.generation,
      provider: 'fixture', model: 'fixture', system: request.system, input: JSON.stringify(request.input) }
    return dreamModelStep(job, request.tools, fixtureOptions)
  }
  let model: DreamCalculate = defaultModel
  let beforeMutation = () => {}
  let afterCommit: (receipt: DocumentReceipt) => void = () => {}
  const start = () => createMemoryDreamJobs({ notes, documents, effects, identity: { newId: randomUUID, hash: memoryHash }, now: () => now,
    settings: { timezone: 'UTC', dreamUnits: options.units ?? 5, dreamBatchBytes: options.budget ?? 40_000 },
    readable, eligible: () => true, source: id => store.readSource(id) ?? undefined,
    reference: id => { const original = store.readSource(id); return original ? { namespace: 'canonical', sourceId: id, revision: original.version } : null },
    transaction: store.tx, mutate: async work => { beforeMutation(); return work() }, committed: receipt => afterCommit(receipt),
    allowsText: text => !looksSecret(text),
    calculate: async request => { requests.push(request); assert.equal(request.current(), true); return model(request) },
  })
  let jobs = start()
  t.after(() => { effects.close(); store.close() })
  const addSource = (text: string, props: Partial<MemorySource> = {}) => noteSource(store, {
    text, hash: memoryHash(text), length: text.length, at: now, timezone: 'UTC', ...props,
  })
  const add = (text: string, title = 'Report', props: Partial<MemorySource> = {}) => {
    const original = addSource(text, { session: randomUUID(), ...props })
    const key = notes.add(original.session!, '2026-11-16', [original], '')!
    assert(notes.commit(key, notes.pending(key), { status: 'write', title, markdown: text }, 1, now, notes.snapshot([original.id]), undefined))
    return { source: original, key, note: notes.read(key)! }
  }
  const run = async () => { jobs.run(); await effects.wake() }
  return { store, notes, documents, requests, addSource, add, run, defaultModel,
    setFixture(options: Parameters<typeof dreamModelStep>[2]) { fixtureOptions = options },
    setModel(next: DreamCalculate) { model = next },
    beforeMutation(next: () => void) { beforeMutation = next }, afterCommit(next: (receipt: DocumentReceipt) => void) { afterCommit = next },
    advance(ms: number) { now += ms },
    async retry() { now += 60_000; await effects.wake() },
    restart() { effects.close(); effects = createEffects({ db: store.db, now: () => now, later: () => null, cancel: () => {} }); jobs = start() },
    sourceRef: (original: MemorySource) => ({ id: original.id, token: memorySourceToken(original) }),
  }
}

test('four-stage dream combines daily files in one authorized workspace through real tools, verifies originals and checkpoints', async t => {
  const h = harness(t)
  const first = h.add('The report is due each Friday.'), second = h.add('Include the reviewed totals in the report.')
  await h.run()
  assert.deepEqual(h.requests.map(item => item.stage), ['extract', 'integrate', 'verify', 'tag'])
  const docs = h.documents.list(first.note.workspace)
  assert.equal(docs.length, 1)
  assert.match(docs[0]!.markdown, /memory_tags:/u)
  assert.deepEqual(new Set(docs[0]!.sources.map(ref => ref.id)), new Set([first.source.id, second.source.id]))
  assert(docs[0]!.sources.every(ref => ref.spans?.length))
  const verify = h.requests.find(item => item.stage === 'verify')!
  assert.deepEqual(new Set(verify.sourceIds()), new Set([first.source.id, second.source.id]))
  assert.equal(h.notes.changed('2026-11-16', '2026-11-16').length, 0)
  assert.equal(h.store.db.prepare("SELECT COUNT(*) n FROM effects WHERE kind='memory.extract'").get()?.n, 0)
})

test('unchanged ambiguous work is dormant across restart; an original answer resumes it without repeating Extract', async t => {
  const h = harness(t), first = h.add('The report deadline is Friday, unless the review is delayed.')
  h.setModel(request => request.stage === 'integrate' ? Promise.resolve('{"status":"deferred","reason":"Which review deadline applies?"}') : h.defaultModel(request))
  await h.run()
  const work = h.documents.pending(first.note.workspace)[0]!
  assert.equal(work.status, 'pending_clarification')
  assert.equal(h.notes.read(first.key)?.processed, 0)
  h.restart(); const count = h.requests.length
  await h.run()
  assert.equal(h.requests.length, count, 'dormant work is not a technical retry')
  const answer = h.addSource('Friday always applies to the weekly report.')
  h.documents.answer({ operationId: randomUUID(), workspace: first.note.workspace, deferredId: work.operationId, source: h.sourceRef(answer), text: answer.text! })
  h.setModel(h.defaultModel)
  await h.run()
  assert.deepEqual(h.requests.slice(count).map(item => item.stage), ['integrate', 'verify', 'tag'])
  assert.equal(h.documents.pending(first.note.workspace).length, 0)
  assert.equal(h.documents.list(first.note.workspace).length, 1)
  assert.equal(h.notes.read(first.key)?.processed, h.notes.read(first.key)?.revision)
})

test('an insufficient clarification creates a new dormant question and never loops on the old answer operation', async t => {
  const h = harness(t), first = h.add('There is a conditional deadline.')
  h.setModel(request => request.stage === 'integrate' ? Promise.resolve('{"status":"deferred","reason":"Which condition applies?"}') : h.defaultModel(request))
  await h.run()
  const old = h.documents.pending(first.note.workspace)[0]!
  const answer = h.addSource('It depends on the reviewer.')
  h.documents.answer({ operationId: randomUUID(), workspace: first.note.workspace, deferredId: old.operationId, source: h.sourceRef(answer), text: answer.text! })
  await h.run()
  const pending = h.documents.pending(first.note.workspace)
  assert.equal(pending.length, 1)
  assert.notEqual(pending[0]!.operationId, old.operationId)
  assert.equal(pending[0]!.status, 'pending_clarification')
  const count = h.requests.length
  await h.run()
  assert.equal(h.requests.length, count)
  assert.equal(h.notes.read(first.key)?.processed, 0)
})

test('successful paths checkpoint independently while a failed unit remains durable and retries once', async t => {
  const h = harness(t), first = h.add('First report arrangement.', 'First'), second = h.add('Second report arrangement.', 'Second')
  let failed = true
  h.setModel(async request => {
    if (request.stage === 'extract') {
      const input = request.input as { notes: Array<{ path: string, title: string }> }
      return JSON.stringify({ units: input.notes.map(note => ({ name: note.title, summary: note.title + ' report arrangement', bucket: 'personal', paths: [note.path] })) })
    }
    if (request.stage === 'integrate' && (request.input as { unit: { name: string } }).unit.name === 'Second' && failed) throw new Error('model transport failed')
    return h.defaultModel(request)
  })
  await h.run()
  assert.equal(h.notes.read(first.key)?.processed, h.notes.read(first.key)?.revision)
  assert.equal(h.notes.read(second.key)?.processed, 0)
  failed = false; h.restart(); await h.retry()
  assert.equal(h.documents.list(first.note.workspace).length, 2)
  assert.equal(h.notes.read(second.key)?.processed, h.notes.read(second.key)?.revision)
  assert.equal(h.requests.filter(request => request.stage === 'extract').length, 1)
  assert.equal(h.requests.filter(request => request.stage === 'integrate' && (request.input as { unit: { name: string } }).unit.name === 'First').length, 1)
})

test('unit budget does not checkpoint files that were never scanned or integrated', async t => {
  const h = harness(t, { units: 1, budget: 1 }), first = h.add('First report.'), second = h.add('Second report.')
  await h.run()
  const rows = [h.notes.read(first.key)!, h.notes.read(second.key)!]
  assert.equal(rows.filter(note => note.processed === note.revision).length, 1)
  assert.equal(rows.filter(note => note.processed === 0).length, 1)
  assert.equal(h.requests.filter(request => request.stage === 'extract').length, 1)
})

test('a committed document survives a lost completion callback; restart replays receipt without another model integration', async t => {
  const h = harness(t), first = h.add('Report on Friday.')
  let lost = true
  h.afterCommit(() => { if (lost) { lost = false; throw new Error('lost post-commit completion') } })
  await h.run()
  assert.equal(h.documents.list(first.note.workspace).length, 1)
  assert.equal(h.notes.read(first.key)?.processed, 0)
  h.restart(); await h.retry()
  assert.equal(h.documents.list(first.note.workspace).length, 1)
  assert.equal(h.requests.filter(request => request.stage === 'integrate').length, 1)
  assert.equal(h.requests.filter(request => request.stage === 'verify').length, 1)
  assert.equal(h.notes.read(first.key)?.processed, h.notes.read(first.key)?.revision)
})

test('Auto Tag failure is recorded separately, preserves the document and checkpoint, and is not retried', async t => {
  const h = harness(t), first = h.add('Report on Friday.')
  h.setModel(request => { if (request.stage === 'tag') throw new Error('tag model unavailable'); return h.defaultModel(request) })
  await h.run()
  assert.equal(h.documents.list(first.note.workspace).length, 1)
  const doc = h.documents.list(first.note.workspace)[0]!
  const attempt = h.documents.tagAttempt(doc.workspace, `tag:${memoryHash(JSON.stringify([doc.workspace, doc.id, doc.revision]))}`)
  assert.equal(attempt?.state, 'failed')
  assert.equal(h.notes.read(first.key)?.processed, h.notes.read(first.key)?.revision)
  await h.run()
  assert.equal(h.requests.filter(request => request.stage === 'tag').length, 1)
})

test('the commit checks sources again after waiting for a mutation/send fence', async t => {
  const h = harness(t), first = h.add('Report on Friday.')
  let verified = false
  h.setModel(async request => { const result = await h.defaultModel(request); if (request.stage === 'verify') verified = true; return result })
  h.beforeMutation(() => {
    if (verified) h.store.db.prepare('UPDATE memory_sources SET withdrawn=1 WHERE id=?').run(first.source.id)
  })
  await h.run()
  assert.equal(h.documents.list(first.note.workspace).length, 0)
  assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM memory_document_revisions').get()?.n, 0)
})

test('a disabled fragment is never re-sent through a mixed daily file, while an independent source is eligible', async t => {
  const h = harness(t), first = h.add('Friday reporting. Monday planning.')
  await h.run()
  const doc = h.documents.list(first.note.workspace)[0]!
  h.documents.setEnabled({ operationId: randomUUID(), workspace: doc.workspace, documentId: doc.id,
    expectedRevision: doc.revision, expectedUsageVersion: doc.usageVersion, enabled: false })
  h.store.db.prepare('UPDATE memory_daily_notes SET processed=0').run()
  const count = h.requests.length
  await h.run()
  assert.equal(h.requests.length, count)
  h.add('An independent release schedule.', 'Release')
  h.setModel(async request => request.stage === 'extract'
    ? JSON.stringify({ units: [{ name: 'Release', summary: 'Independent release schedule', bucket: 'procedure', paths: (request.input as { notes: Array<{ path: string }> }).notes.map(note => note.path) }] })
    : h.defaultModel(request))
  await h.run()
  assert.equal(h.documents.list(first.note.workspace).length, 1)
  assert(h.requests.slice(count).every(request => !JSON.stringify(request.input).includes('Friday reporting')))
})

test('batching uses UTF-8 bytes, groups days when possible, and retains an oversized single file', () => {
  const notes = [{ day: 'one', document: '城城' }, { day: 'one', document: '城城' }, { day: 'two', document: 'z'.repeat(30) }]
  assert.deepEqual(batchDreamNotes(notes, 15).map(batch => batch.length), [2, 1])
  assert.deepEqual(batchDreamNotes(notes, 5).map(batch => batch.length), [1, 1, 1])
  assert.throws(() => batchDreamNotes(notes, -1))
})

test('only exact backend-issued file references are excluded from credential inspection', () => {
  const path = 'daily/2026-11-16/note-' + memoryHash('trusted note') + '.md'
  const session = 'session/dialog/' + memoryHash('trusted session') + '.jsonl'
  const markdown = `---\nsource_conversation: "[[${session}]]"\n---\nThe report is supported by [[${path}]].`
  assert.equal(looksSecret(markdown), true)
  assert.equal(looksSecret(inspectMemoryDocumentText(markdown, [path, session])), false)
  const secret = 'sk-abcdefghijklmnopqrstuv'
  assert.equal(looksSecret(inspectMemoryDocumentText(markdown + '\n' + secret, [path, session])), true)
  assert.equal(looksSecret(inspectMemoryDocumentText(markdown, [])), true)
})

test('semantic review retains a separate model verdict and deterministic evidence/attribution boundaries', () => {
  const original = { id: 'source', version: 1, text: 'The reviewer, not I, moved to Paris.', withdrawn: false } as MemorySource
  const value = { verdict: 'verified', action: 'CREATE', classification: 'unrelated',
    checks: { attribution: true, polarity: true, time: true, conditions: true, meaning: true, sources: true, action: true },
    evidence: [{ sourceId: original.id, sourceVersion: 1, start: 0, end: original.text!.length, text: original.text, claim: 'The reviewer moved.' }], changeEvidence: [], corrections: [] }
  const options = { value, action: 'CREATE' as const, sources: [{ id: 'source', token: 'version' }], source: () => original, reads: [], unitSources: [['source']] }
  assert.equal(validateDreamReview(options).verdict, 'verified')
  assert.throws(() => validateDreamReview({ ...options, value: { ...value, evidence: [{ ...value.evidence[0], text: 'I moved to Paris.' }] } }), /evidence-span/u)
  assert.equal(validateDreamReview({ ...options, value: { verdict: 'deferred', reason: 'Attribution is ambiguous.' } }).verdict, 'deferred')
  assert.equal(validateDreamReview({ ...options, value: { ...value, classification: 'same_abstraction' } }).verdict, 'deferred')
  assert.throws(() => validateDreamReview({ ...options, restricted: () => true }), /evidence-restricted/u)
})

for (const action of ['CORROBORATE', 'REFINE', 'CORRECT'] as const) test(`${action} uses the same logical node, retains old evidence and links, and commits only after review`, async t => {
  const h = harness(t)
  h.setFixture({ summary: 'The report is due Friday.' })
  const first = h.add('The report is due Friday.')
  await h.run()
  const before = h.documents.list(first.note.workspace)[0]!
  const newText = action === 'CORRECT' ? 'Correction: the report deadline is Monday, replacing Friday.'
    : action === 'REFINE' ? 'Include reviewed totals with the Friday report.' : 'I confirm that the report deadline is Friday.'
  const next = h.add(newText)
  h.setFixture({ summary: newText, action })
  h.setModel(async request => {
    const result = await h.defaultModel(request)
    if (request.stage !== 'verify' || action !== 'CORRECT') return result
    const review = JSON.parse(result!) as { evidence: Array<{ sourceId: string }>, changeEvidence: unknown[], corrections: unknown[] }
    const line = before.markdown.split('\n').findIndex(value => value === 'The report is due Friday.') + 1
    assert(line > 0)
    review.changeEvidence = review.evidence.filter(item => item.sourceId === next.source.id)
    review.corrections = [{ path: before.path, revision: before.revision, startLine: line, endLine: line,
      text: 'The report is due Friday.', condition: 'the weekly report', time: 'current deadline' }]
    return JSON.stringify(review)
  })
  await h.run()
  const docs = h.documents.list(first.note.workspace)
  assert.equal(docs.length, 1)
  assert.equal(docs[0]!.id, before.id)
  assert.notEqual(docs[0]!.revision, before.revision)
  assert.match(docs[0]!.markdown, new RegExp(first.note.path.replaceAll('.', '\\.')))
  assert.match(docs[0]!.markdown, new RegExp(next.note.path.replaceAll('.', '\\.')))
  assert.deepEqual(new Set(docs[0]!.sources.map(ref => ref.id)), new Set([first.source.id, next.source.id]))
  assert.equal(docs[0]!.corrections.length, action === 'CORRECT' ? 1 : 0)
  assert.equal(h.notes.read(next.key)?.processed, h.notes.read(next.key)?.revision)
  if (action === 'CORRECT') {
    // TAG has its own content hash; replacement validity follows the retained logical relation.
    const correction = docs[0]!.corrections[0]!
    assert.equal(correction.documentId, docs[0]!.id)
    h.setFixture({ action: 'REFINE', summary: 'Send the Monday report with a reviewed attachment.' })
    h.add('Add a reviewed attachment to the Monday report.')
    h.setModel(h.defaultModel)
    await h.run()
    assert.equal(h.documents.list(first.note.workspace)[0]?.corrections[0]?.operationId, correction.operationId)
  }
})

test('an explicit clarification answer resumes dormant work after its daily file leaves the automatic scan window', async t => {
  const h = harness(t), first = h.add('Report deadline depends on the review.')
  h.setModel(request => request.stage === 'integrate' ? Promise.resolve('{"status":"deferred","reason":"Which deadline applies?"}') : h.defaultModel(request))
  await h.run()
  const pending = h.documents.pending(first.note.workspace)[0]!
  h.advance(8 * 86_400_000)
  const answer = h.addSource('The report is due Friday.')
  h.documents.answer({ operationId: randomUUID(), workspace: first.note.workspace, deferredId: pending.operationId,
    source: h.sourceRef(answer), text: answer.text! })
  h.setModel(h.defaultModel)
  await h.run()
  assert.equal(h.documents.list(first.note.workspace).length, 1)
  assert.equal(h.documents.pending(first.note.workspace).length, 0)
  assert.equal(h.notes.read(first.key)?.processed, h.notes.read(first.key)?.revision)
})

test('question succession and the persisted dream plan commit atomically across an interrupted second clarification', async t => {
  const h = harness(t), first = h.add('Report deadline depends on review.')
  h.setModel(request => request.stage === 'integrate' ? Promise.resolve('{"status":"deferred","reason":"Which deadline applies?"}') : h.defaultModel(request))
  await h.run()
  const old = h.documents.pending(first.note.workspace)[0]!
  const answer = h.addSource('It depends on the reviewer.')
  h.documents.answer({ operationId: randomUUID(), workspace: first.note.workspace, deferredId: old.operationId, source: h.sourceRef(answer), text: answer.text! })
  const defer = h.documents.defer
  h.documents.defer = (input, previous) => {
    const result = defer(input, previous)
    if (previous) throw new Error('interrupted between question write and plan write')
    return result
  }
  await h.run()
  const afterFailure = h.documents.pending(first.note.workspace)
  assert.equal(afterFailure.length, 1)
  assert.equal(afterFailure[0]?.operationId, old.operationId)
  assert.equal(afterFailure[0]?.status, 'ready')
  h.documents.defer = defer
  h.restart(); await h.retry()
  const pending = h.documents.pending(first.note.workspace)
  assert.equal(pending.length, 1)
  assert.notEqual(pending[0]?.operationId, old.operationId)
  assert.equal(pending[0]?.status, 'pending_clarification')
  const count = h.requests.length
  await h.run()
  assert.equal(h.requests.length, count)
})

test('a question containing refused material is not reintroduced during independent semantic review', async t => {
  const h = harness(t), secret = 'sk-abcdefghijklmnopqrstuv'
  h.add('The report is due Friday.', 'Report', { author: 'answer', question: `Does ${secret} affect the report?` })
  await h.run()
  const verify = h.requests.find(request => request.stage === 'verify')!
  assert.ok(verify)
  assert.equal(JSON.stringify(verify.input).includes(secret), false)
  assert.equal((verify.input as { canonicalSources: Array<{ questionUnavailable: boolean }> }).canonicalSources[0]?.questionUnavailable, true)
})

test('Extract presents replaced daily fragments together with current correction content and its live dependency set', async t => {
  const h = harness(t), first = h.add('The report is due Friday.')
  h.setFixture({ summary: 'The report is due Friday.' })
  await h.run()
  const before = h.documents.list(first.note.workspace)[0]!
  const correction = h.addSource('Correction: Monday replaces Friday as the report deadline.')
  const line = first.note.document.split('\n').findIndex(line => line === first.source.text) + 1
  const fixed = h.documents.commit({ operationId: randomUUID(), workspace: first.note.workspace, path: before.path,
    expectedRevision: before.revision, markdown: before.markdown.replaceAll('The report is due Friday.', 'The report is due Monday.'),
    action: 'CORRECT', sources: [...before.sources, h.sourceRef(correction)], reads: [before],
    corrections: [{ path: first.note.path, revision: first.note.fileRevision, startLine: line, endLine: line,
      text: first.source.text!, condition: 'weekly report', time: 'current deadline' }] })
  const corrected = h.documents.read(first.note.workspace, fixed.path)!
  h.documents.commit({ operationId: randomUUID(), workspace: first.note.workspace, path: corrected.path, expectedRevision: corrected.revision,
    markdown: updateMemoryFrontmatter(corrected.markdown, { memory_tags: ['weekly', 'report'] }), action: 'TAG', sources: corrected.sources, reads: [corrected] })
  h.store.db.prepare('UPDATE memory_daily_notes SET processed=0 WHERE key=?').run(first.key)
  const count = h.requests.length
  h.setModel(async request => {
    assert.equal(request.stage, 'extract')
    const input = request.input as { notes: Array<{ applicability: { state: string }, replacements: Array<{ markdown: string }> }> }
    assert.equal(input.notes[0]?.applicability.state, 'superseded')
    assert.match(input.notes[0]!.replacements[0]!.markdown, /Monday/u)
    assert(request.sourceIds().includes(correction.id))
    return '{"units":[]}'
  })
  await h.run()
  assert.equal(h.requests.length, count + 1)
  assert.equal(h.notes.read(first.key)?.processed, h.notes.read(first.key)?.revision)
})

test('question provenance is bound to the review request and retained with short-answer evidence', async t => {
  const h = harness(t)
  const context = h.addSource('Choose the deadline for the weekly report.')
  const answer = h.addSource('Friday', { author: 'answer', question: 'Which day is the weekly report due?', session: 'answer-session' })
  const key = h.notes.add(answer.session!, '2026-11-16', [answer], '', answer.id, [], '', { questionCurrent: true, questionSources: [context.id] })!
  assert(h.notes.commit(key, h.notes.pending(key), { status: 'write', title: 'Report', markdown: 'The weekly report is due Friday.' }, 1,
    Date.parse('2026-11-16T12:00:00Z'), h.notes.snapshot([answer.id]), undefined))
  const note = h.notes.read(key)!
  h.setFixture({ summary: 'The weekly report is due Friday.', evidenceId: answer.id })
  await h.run()
  const verify = h.requests.find(request => request.stage === 'verify')!
  assert(verify.sourceIds().includes(context.id))
  const input = verify.input as { canonicalSources: Array<{ sourceId: string, question: string | null }> }
  assert.equal(input.canonicalSources.find(source => source.sourceId === answer.id)?.question, answer.question)
  const document = h.documents.list(note.workspace)[0]!
  assert.deepEqual(new Set(document.sources.map(ref => ref.id)), new Set([answer.id, context.id]))
  h.store.db.prepare('UPDATE memory_sources SET withdrawn=1 WHERE id=?').run(context.id)
  h.documents.withdraw(context.id)
  assert.equal(h.documents.list(note.workspace).length, 0)
})

test('a TAG receipt recovers its own expanded readset after interruption while another unit is still retrying', async t => {
  const h = harness(t), first = h.add('The report is due Friday. Attach the reviewed totals.')
  h.setFixture({ summary: 'The report is due Friday. Attach the reviewed totals.' })
  await h.run()
  const before = h.documents.list(first.note.workspace)[0]!
  const correction = h.addSource('Correction: Monday replaces Friday as the report deadline. Reviewed totals are still required.')
  const line = first.note.document.split('\n').findIndex(line => line === first.source.text) + 1
  h.documents.commit({ operationId: randomUUID(), workspace: first.note.workspace, path: before.path, expectedRevision: before.revision,
    markdown: before.markdown.replaceAll('Friday', 'Monday'), action: 'CORRECT', sources: [...before.sources, h.sourceRef(correction)], reads: [before],
    corrections: [{ path: first.note.path, revision: first.note.fileRevision, startLine: line, endLine: line,
      text: first.source.text!, condition: 'weekly report', time: 'current deadline' }] })
  h.store.db.prepare('UPDATE memory_daily_notes SET processed=0 WHERE key=?').run(first.key)
  const start = h.requests.length
  let failed = true, interrupted = true
  h.setFixture({})
  // Change the fixture's tag set so this update really writes another content revision.
  const originalModel = h.defaultModel
  h.setModel(async request => {
    if (request.stage === 'extract') return JSON.stringify({ units: [
      { name: 'Report', bucket: 'personal', summary: 'The report deadline is Monday.', paths: [first.note.path] },
      { name: 'Attachment', bucket: 'procedure', summary: 'Attach reviewed totals.', paths: [first.note.path] },
    ] })
    if (request.stage === 'integrate' && (request.input as { unit: { name: string } }).unit.name === 'Attachment' && failed) throw new Error('second unit transport failure')
    if (request.stage === 'tag') return '{"memory_tags":["weekly","reviewed"]}'
    return originalModel(request)
  })
  h.afterCommit(receipt => { if (receipt.action === 'TAG' && interrupted) { interrupted = false; throw new Error('interrupted after TAG journal receipt') } })
  await h.run()
  assert.equal(interrupted, false, 'the first unit reached a persisted TAG revision')
  assert.equal(h.notes.read(first.key)?.processed, 0)
  failed = false; h.restart(); await h.retry()
  assert.equal(h.requests.slice(start).filter(request => request.stage === 'extract').length, 1)
  assert.equal(h.requests.slice(start).filter(request => request.stage === 'integrate' && (request.input as { unit: { name: string } }).unit.name === 'Report').length, 1)
  assert.equal(h.documents.list(first.note.workspace).length, 2)
  assert.equal(h.notes.read(first.key)?.processed, h.notes.read(first.key)?.revision)
})

test('reading a narrow existing node after a broader daily source never narrows the accumulated evidence readset', async t => {
  const h = harness(t), text = 'Report Friday. Planning Monday.', first = h.add(text)
  const split = text.indexOf('Planning')
  h.documents.commit({ operationId: randomUUID(), workspace: first.note.workspace, path: 'digest/personal/Report.md', expectedRevision: null,
    markdown: formatMemoryDocument({ metadata: { name: 'Report', description: 'Report Friday' }, body: `Report Friday.\nSupported by [[${first.note.path}]].` }),
    action: 'CREATE', sources: [{ ...h.sourceRef(first.source), spans: [{ start: 0, end: split }] }], reads: [] })
  h.setFixture({ name: 'Planning', summary: 'Planning Monday.', evidenceId: first.source.id })
  h.setModel(async request => {
    if (request.stage === 'integrate' && request.tools) {
      const tools = request.tools
      return h.defaultModel({ ...request, tools: { ...tools, async executeTool(invocation) {
        const result = await tools.executeTool(invocation)
        if (invocation.name === 'read') {
          const related = await tools.executeTool({ callId: 'late-related-search', name: 'node_search', input: { query: 'Report' } })
          assert.equal(related.state, 'completed')
        }
        return result
      } } })
    }
    const result = await h.defaultModel(request)
    if (request.stage !== 'verify') return result
    const review = JSON.parse(result!) as { evidence: Array<{ start: number, end: number, text: string }> }
    review.evidence[0] = { ...review.evidence[0]!, start: split, end: text.length, text: text.slice(split) }
    return JSON.stringify(review)
  })
  await h.run()
  const planning = h.documents.read(first.note.workspace, 'digest/personal/Planning.md')
  assert.ok(planning)
  assert.deepEqual(planning.sources[0]?.spans, [{ start: split, end: text.length }])
  assert.equal(h.notes.read(first.key)?.processed, h.notes.read(first.key)?.revision)
})
