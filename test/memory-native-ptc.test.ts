import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, interruptedTurnClosers, Session, SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { ResolvedToolSet, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { HostMemoryApi } from '../src/memory/contracts/host.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { openNativeOriginalMaintenance } from '../src/memory/node/native-original-maintenance.ts'
import { createNativeOutputAttempts } from '../src/memory/node/native-output-attempts.ts'
import { NATIVE_OUTPUT_MARKER } from '../plugins/memory/lib/native/output-attempts.ts'
import { eraseColdNativeCopies } from '../plugins/memory/lib/native/maintenance.ts'
import { trackNativeToolReads } from '../plugins/memory/lib/native/tool-reads.ts'
import { nativeEventDigest } from '../plugins/memory/lib/native/event-digest.ts'
import { inspectPtcResultWindow, provesUnflushedPtcTail } from '../plugins/memory/lib/native/project-native-ptc.ts'
import { scratch } from './fixtures/scratch.js'

for (const scenario of ['settled-fork', 'interrupted', 'output-overlap', 'child-unprepared', 'child-known-result', 'child-cold-repair', 'child-repair-continued', 'spill-pending', 'missing-origin'] as const) {
  test(`PTC exact input lineage and full-catalog no-output recovery: ${scenario}`, async t => {
    const { dir } = scratch(t, 'viva-native-ptc-'), memoryRoot = join(dir, 'memory'), root = join(dir, 'sessions')
    const owner = openMemoryOwner({ root: memoryRoot, hostNamespace: 'viva',
      compute: () => null, route: () => null, quiesce: async () => {} })
    await owner.recover()
    const created = await owner.handleHost('createFile', { args: [{ operationId: randomUUID(), text: 'Exact private PTC source.' }] }) as HostMemoryApi['createFile']['output']
    const session = Session.create(SessionId(randomUUID())), signal = new AbortController().signal
    owner.initializeSession({ sessionId: String(session.id), cwd: dir })
    const tools: ResolvedToolSet = { dispose() {}, view: () => new Map() }
    const tracker = trackNativeToolReads(owner.finishNativeToolRead, { evidence: owner.nativeToolEvidence, archive: owner.inheritNativeToolRead })
    const token = () => Symbol() as ToolExecutionToken
    tracker.assembly(session, signal, tools); tracker.step(session, 1, 1, signal)
    session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
    const rootId = ToolCallId('program'), leafId = ToolCallId('leaf'), independentId = ToolCallId('independent'), derivedId = ToolCallId('derived')
    const marker = { id: randomUUID(), generation: 0, turn: 1, step: 1 }
    const floor = scenario === 'output-overlap' ? appendPluginRecord(session, NATIVE_OUTPUT_MARKER, marker) + 1 : 0
    const announcement = session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' },
      content: [{ type: 'tool-call', id: rootId, name: 'run_code', arguments: '{}' }] }), stream: [] }, { surfaceOp: 'append' })
    if (scenario === 'output-overlap') {
      owner.runtime.handle({ op: 'file_read', session: session.id, id: created.identity.id }, owner.sessionContext(session.id))
      const archive = new DatabaseSync(join(memoryRoot, 'memory.db'))
      try {
        const attempts = createNativeOutputAttempts(archive), attempt = { ...marker, session: String(session.id), floor }
        attempts.record(attempt, owner.dispatch.snapshot(session.id))
        attempts.finish(attempt, { seq: announcement.seq, kind: 'reply', digest: nativeEventDigest(announcement) })
      } finally { archive.close() }
    }
    const native = session.append('tool/call', { turn: 1, step: 1, callId: rootId, name: 'run_code', arguments: '{}' })
    tracker.observe(session, native)
    const rootExec: ToolExecution = { callId: rootId, rootCallId: rootId, name: 'run_code', arguments: {}, signal, toolSet: tools, token: token() }
    tracker.bind(session, rootExec)
    const rootLease = tracker.acquire(session, rootExec, 0)!
    function start(id: typeof rootId, name: string, args: Record<string, unknown>) {
      const event = session.append('tool/ptc-dispatch-start', { rootCallId: rootId, parentCallId: rootId, subCallId: id, name, arguments: args })
      tracker.observe(session, event)
      const exec = { ...rootExec, callId: id, name, arguments: args, parent: rootExec.token, token: token() }
      tracker.bind(session, exec)
      return { event, lease: tracker.acquire(session, exec, 0)! }
    }
    const independent = start(independentId, 'echo', { text: 'Exact private PTC source.' })
    const leaf = start(leafId, 'memory_read', { id: created.identity.id })
    const text = owner.withNativeToolRead(leaf.lease, () => owner.runtime.handle({ op: 'file_read', session: session.id, id: created.identity.id },
      { session: session.id, conversation: session.id }))
    assert.match(text ?? '', /Exact private/u)
    const parentPrefix = session.snapshotEvents()
    const coldRepair = scenario === 'child-cold-repair' || scenario === 'child-repair-continued'
    const childOnly = scenario.startsWith('child-'), unprepared = scenario === 'child-unprepared' || coldRepair
    const derived = unprepared
      ? { event: session.append('tool/ptc-dispatch-start', { rootCallId: rootId, parentCallId: rootId, subCallId: derivedId,
        name: 'memory_node_search', arguments: { query: text } }), lease: undefined }
      : start(derivedId, 'memory_node_search', { query: text })
    const inheritedPrefix = session.snapshotEvents()
    assert.equal(derived.lease?.call.inputDerived, unprepared ? undefined : true)
    assert.equal(independent.lease.call.inputDerived, undefined, 'a pre-read concurrent leaf is independent')
    const settled = scenario === 'settled-fork'
    const outputs = new Map<number, number>()
    if (scenario === 'child-known-result') tracker.observe(session, session.append('tool/ptc-dispatch', { ...derived.event.data,
      isError: false, content: [{ type: 'text', text: 'Volatile result never flushed by the parent or inherited by the child.' }] }))
    if (settled) {
      for (const item of [derived, independent, leaf]) {
        const event = session.append('tool/ptc-dispatch', { ...item.event.data, content: [{ type: 'text', text: 'Exact private PTC source.' }],
          isError: true, error: { name: 'Fixture', code: 'fixture', reason: 'Exact private PTC source.' }, meta: { extra: 'Exact private PTC source.' } })
        outputs.set(item.event.seq, event.seq)
        tracker.observe(session, event)
      }
      tracker.observe(session, session.append('tool/result', { turn: 1, step: 1,
        message: createToolResultMessage({ callId: rootId, content: [{ type: 'text', text: 'Exact private PTC source.' }], isError: false }) },
      { surfaceOp: 'append', sourceEventSeqs: [native.seq] }))
    }
    if (scenario === 'spill-pending') owner.beginNativeSpill({ call: rootLease.call, root: join(dir, 'opaque-spills'),
      hash: createHash('sha256').update('unknown result').digest('hex'), bytes: 14 })
    let repaired: readonly SessionEvent[] = []
    if (coldRepair) {
      const cold = new Context(), mounted = await cold.plugin(jsonl, { root, compression: 'zstd' })
      try {
        const initial = await cold.sessionPersistence.create(session.header)
        try { await initial.append(parentPrefix); await initial.flush() } finally { await initial.close() }
        // Exactly the public cold-resume repair used by the pinned agent loop,
        // committed before the user asks to forget the still-current source.
        const writer = await cold.sessionPersistence.open(session.id, 'write')
        try {
          const persisted = (await writer.read()).events
          const restored = Session.create(session.id, [...persisted, ...interruptedTurnClosers(persisted)], session.header)
          if (scenario === 'child-repair-continued') {
            restored.append('turn/start', { turn: 2 }); restored.append('step/start', { turn: 2, step: 1 })
            const marker = { id: randomUUID(), generation: 0, turn: 2, step: 1 }
            const floor = appendPluginRecord(restored, NATIVE_OUTPUT_MARKER, marker) + 1
            const output = restored.append('assistant/message', { turn: 2, step: 1, message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' },
              content: [{ type: 'text', text: 'Exact private PTC source.' }] }), stream: [] }, { surfaceOp: 'append' })
            const archive = new DatabaseSync(join(memoryRoot, 'memory.db'))
            try {
              const attempts = createNativeOutputAttempts(archive), attempt = { ...marker, session: String(session.id), floor }
              attempts.record(attempt, { dependencies: [], sources: [], epoch: 0, turnOnly: false })
              attempts.finish(attempt, { seq: output.seq, kind: 'reply', digest: nativeEventDigest(output) })
            } finally { archive.close() }
            restored.append('step/end', { turn: 2, step: 1 }); restored.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
          }
          repaired = restored.snapshotEvents()
          await writer.append(repaired.slice(persisted.length)); await writer.flush()
        } finally { await writer.close() }
      } finally { await mounted.dispose() }
      assert.match(owner.runtime.handle({ op: 'file_read', session: session.id, id: created.identity.id }, owner.sessionContext(session.id)) ?? '', /Exact private/u)
    }
    const detail = await owner.handleHost('readFile', { args: [created.identity] }) as HostMemoryApi['readFile']['output']
    assert.ok(detail)
    await owner.handleHost('forgetFile', { args: [{ operationId: randomUUID(), identity: created.identity, version: detail.version }] })
    await owner.close()
    const prefix = childOnly ? inheritedPrefix : session.snapshotEvents(), inherited = SessionLogOffset(prefix.length), forkId = SessionId(randomUUID())
    const fork = Session.create(forkId, prefix, { ...session.header, id: forkId, isSeeded: true }, inherited)
    const context = new Context(), mounted = await context.plugin(jsonl, { root, compression: 'zstd' })
    try {
      for (const copy of [session, ...settled || childOnly ? [fork] : []]) {
        if (copy === session && coldRepair) continue
        const writer = await context.sessionPersistence.create(copy.header, { inheritedEventCount: copy === fork ? inherited : SessionLogOffset(0) })
        try { await writer.append(copy === session && childOnly ? parentPrefix : copy.snapshotEvents()); await writer.flush() } finally { await writer.close() }
      }
    } finally { await mounted.dispose() }
    if (scenario === 'missing-origin') {
      // A missing origin cannot establish physical absence from an unrelated catalog.
      const { rm } = await import('node:fs/promises')
      await rm(root, { recursive: true }); const { mkdir } = await import('node:fs/promises'); await mkdir(root)
    }
    const erase = () => eraseColdNativeCopies({ memoryRoot, sessionsRoot: root, storageRoot: join(dir, 'storages'), hostNamespace: 'viva',
      isCold: () => true, trace: { key: () => undefined, erase: () => {} } })
    await erase(); await erase()
    const admin = openNativeOriginalMaintenance(memoryRoot, 'viva')!
    try {
      const pending = admin.unsettledReceipts().tools
      if (scenario === 'spill-pending') assert.ok(pending.some(call => call.id === rootLease.call.id))
      else if (scenario === 'missing-origin') assert.equal(pending.length, 3)
      else {
        assert.deepEqual(pending, [])
        assert.equal(admin.toolResultOperations().length, 0, 'known endpoints and input-only publications must also be fully retired')
      }
      assert.equal(admin.hasPlans(), scenario === 'spill-pending' || scenario === 'missing-origin',
        'the catalog receipt must reflect every tool and spill obligation')
    } finally { admin.close() }
    if (scenario === 'missing-origin' || scenario === 'spill-pending') return
    const verify = new Context(), install = await verify.plugin(jsonl, { root })
    try {
      for (const id of [session.id, ...settled || childOnly ? [forkId] : []]) {
        const reader = await verify.sessionPersistence.open(id, 'read')
        try {
          const events = (await reader.read()).events
          if (scenario !== 'output-overlap') assert.deepEqual(events[independent.event.seq], independent.event)
          const start = events[derived.event.seq]
          if (coldRepair && id === session.id) {
            assert.equal(start?.type, 'tool/result')
            assert.deepEqual(start, repaired[derived.event.seq], 'the exact TOOL_OUTCOME_UNKNOWN repair row is independent and retained')
            if (scenario === 'child-repair-continued') assert.deepEqual(events, repaired, 'later independently archived identical text is retained')
          } else if (childOnly && id === session.id) assert.equal(start, undefined, 'the parent never flushed the recovered input')
          else {
            assert.equal(start?.type, 'tool/ptc-dispatch-start')
            assert.deepEqual(start.data.arguments, {})
          }
          if (settled) {
            const output = events[outputs.get(derived.event.seq)!]
            assert.equal(output?.type, 'tool/ptc-dispatch')
            assert.deepEqual(output.data.arguments, {})
            assert.deepEqual(output.data.content, [])
            assert.equal(output.data.meta, undefined)
            assert.equal(output.data.error?.reason, undefined)
            assert.deepEqual(events[outputs.get(independent.event.seq)!], prefix[outputs.get(independent.event.seq)!])
          }

        } finally { await reader.close() }
      }
    } finally { await install.dispose() }
  })
}

test('PTC endpoint matching stays inside the original root execution even for invalid repeated IDs', () => {
  const session = Session.create(SessionId(randomUUID())), rootId = ToolCallId('root'), childId = ToolCallId('leaf')
  const root = session.append('tool/call', { turn: 1, step: 1, callId: rootId, name: 'run_code', arguments: '{}' })
  const start = session.append('tool/ptc-dispatch-start', { rootCallId: rootId, parentCallId: rootId, subCallId: childId, name: 'memory_read', arguments: {} })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: rootId, content: [], isError: false }) },
    { surfaceOp: 'append', sourceEventSeqs: [root.seq] })
  session.append('step/end', { turn: 1, step: 1 }); session.append('step/start', { turn: 1, step: 2 })
  session.append('tool/call', { ...root.data, step: 2 })
  session.append('tool/ptc-dispatch-start', start.data)
  session.append('tool/ptc-dispatch', { ...start.data, isError: false, content: [{ type: 'text', text: 'unrelated late result' }] })
  const window = inspectPtcResultWindow(session.snapshotEvents(), { id: randomUUID(), session: String(session.id), callId: childId,
    generation: 0, turn: 1, step: 1, seq: start.seq, digest: nativeEventDigest(start), ptc: { rootCallId: rootId, parentCallId: rootId } })
  assert.ok(window)
  assert.deepEqual(window.results, [])
})

test('an interrupted ordinary memory tool has a cold no-output receipt after the full catalog proves absence', async t => {
  const { dir } = scratch(t, 'viva-native-no-output-'), memoryRoot = join(dir, 'memory'), root = join(dir, 'sessions')
  const owner = openMemoryOwner({ root: memoryRoot, hostNamespace: 'viva',
    compute: () => null, route: () => null, quiesce: async () => {} })
  await owner.recover()
  const file = await owner.handleHost('createFile', { args: [{ operationId: randomUUID(), text: 'Unsettled ordinary file read.' }] }) as HostMemoryApi['createFile']['output']
  const session = Session.create(SessionId(randomUUID())), callId = ToolCallId('native-memory-read')
  owner.initializeSession({ sessionId: String(session.id), cwd: dir })
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' },
    content: [{ type: 'tool-call', id: callId, name: 'memory_read', arguments: '{}' }] }), stream: [] }, { surfaceOp: 'append' })
  const event = session.append('tool/call', { turn: 1, step: 1, callId, name: 'memory_read', arguments: '{}' })
  const call = { id: randomUUID(), session: String(session.id), callId, generation: 0, turn: 1, step: 1, seq: event.seq, digest: nativeEventDigest(event) }
  assert.match(owner.withNativeToolRead({ call, calls: [call], current: () => true }, () => owner.runtime.handle({ op: 'file_read', session: call.session, id: file.identity.id },
    owner.sessionContext(call.session))) ?? '', /Unsettled ordinary/u)
  const detail = await owner.handleHost('readFile', { args: [file.identity] }) as HostMemoryApi['readFile']['output']; assert.ok(detail)
  await owner.handleHost('forgetFile', { args: [{ operationId: randomUUID(), identity: file.identity, version: detail.version }] })
  await owner.close()
  const ctx = new Context(), mounted = await ctx.plugin(jsonl, { root, compression: 'zstd' })
  try {
    const writer = await ctx.sessionPersistence.create(session.header)
    try { await writer.append(session.snapshotEvents()); await writer.flush() } finally { await writer.close() }
  } finally { await mounted.dispose() }
  for (let i = 0; i < 2; i++) await eraseColdNativeCopies({ memoryRoot, sessionsRoot: root, storageRoot: join(dir, 'storages'), hostNamespace: 'viva',
    isCold: () => true, trace: { key: () => undefined, erase: () => {} } })
  const admin = openNativeOriginalMaintenance(memoryRoot, 'viva')!
  try {
    assert.deepEqual(admin.unsettledReceipts().tools, [])
    assert.equal(admin.hasPlans(), false, 'proven absence allows the native participant to finish')
  } finally { admin.close() }
})

test('unflushed PTC tail proof accepts exact cold repair and rejects third payloads, new steps, missing roots and generations', () => {
  const session = Session.create(SessionId(randomUUID())), rootId = ToolCallId('root'), leafId = ToolCallId('read'), laterId = ToolCallId('later')
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' },
    content: [{ type: 'tool-call', id: rootId, name: 'run_code', arguments: '{}' }] }), stream: [] }, { surfaceOp: 'append' })
  const begin = session.append('tool/call', { turn: 1, step: 1, callId: rootId, name: 'run_code', arguments: '{}' })
  const cut = session.append('tool/ptc-dispatch-start', { rootCallId: rootId, parentCallId: rootId, subCallId: leafId, name: 'memory_read', arguments: {} })
  const prefix = session.snapshotEvents()
  const later = session.append('tool/ptc-dispatch-start', { ...cut.data, subCallId: laterId, name: 'echo', arguments: { text: 'source-derived' } })
  const parent = { id: randomUUID(), session: String(session.id), callId: rootId, generation: 0, turn: 1, step: 1, seq: begin.seq, digest: nativeEventDigest(begin) }
  const child = { ...parent, id: randomUUID(), callId: laterId, seq: later.seq, digest: nativeEventDigest(later),
    ptc: { rootCallId: rootId, parentCallId: rootId } }
  const roots = [{ call: parent, cut: { seq: cut.seq, digest: nativeEventDigest(cut) } }]
  const restored = Session.create(session.id, [...prefix, ...interruptedTurnClosers(prefix)], session.header)
  const proof = (events: readonly SessionEvent[], candidate = child) => provesUnflushedPtcTail(events, candidate, roots, () => false)
  assert.equal(proof(prefix), true)
  assert.equal(proof(restored.snapshotEvents()), true)
  const changed = restored.snapshotEvents().map(event => event.type === 'tool/result' ? { ...event, data: { ...event.data,
    message: { ...event.data.message, content: [{ type: 'text' as const, text: 'Independent replacement at the same coordinates.' }] } } } : event)
  assert.equal(proof(changed), false)
  assert.equal(proof([], child), false)
  assert.equal(proof(prefix, { ...child, generation: 1 }), false)
  assert.equal(provesUnflushedPtcTail(prefix, child, [{ call: parent, cut: { seq: cut.seq, digest: '0'.repeat(64) } }], () => false), false)
  restored.append('turn/start', { turn: 2 }); restored.append('step/start', { turn: 2, step: 1 })
  assert.equal(proof(restored.snapshotEvents()), true, 'a later turn cannot invalidate an already proved old repair')
  const unclosed = Session.create(session.id, prefix, session.header)
  unclosed.append('step/start', { turn: 1, step: 2 })
  assert.equal(proof(unclosed.snapshotEvents()), false, 'a new step without the exact old closing batch is not proof')
})
